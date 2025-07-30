# This file managed by the Ren'Py Launch and Sync Visual Studio Code extension.
#
# This script provides a mechanism for your Ren'Py game to connect to VS Code
# via a websocket server. It is automatically excluded from builds of your game.
# You can delete this file if you do not want to use the features provided by
# the extension.
#
# This file should not be checked into source control. You can add it to your
# `.gitignore` file by adding the following line:
#
# renpy_warp_*.rpe*
#

import renpy  # type: ignore
from time import sleep
import textwrap
import threading
import json
import functools
import re
import os
from pathlib import Path
import logging

logging.basicConfig()

logger = logging.getLogger("renpy_warp_service")

try:
    logger.setLevel(level=os.getenv('WARP_LOGLEVEL', logging.INFO))
except ValueError:
    logger.setLevel(level=logging.INFO)


def get_meta():
    RPE_FILE_PATTERN = re.compile(
        r"renpy_warp_(?P<version>\d+\.\d+\.\d+)(?:_(?P<checksum>[a-z0-9]+))?\.rpe(?:\.py)?")

    file = Path(__file__) if __file__.endswith(
        '.rpe.py') else Path(__file__).parent

    filename = os.path.basename(file)
    match = RPE_FILE_PATTERN.match(filename)

    if not match:
        raise Exception(
            f"could not parse filename '{filename}'"
            f" with pattern '{RPE_FILE_PATTERN.pattern}'")

    d = match.groupdict()

    return d["version"], d["checksum"]


def py_exec(text: str):
    while renpy.exports.is_init_phase():
        logger.debug("in init phase, waiting...")
        sleep(0.2)

    fn = functools.partial(renpy.python.py_exec, text)
    renpy.exports.invoke_in_main_thread(fn)


def socket_send(message, websocket):
    """sends a message to the socket server"""
    stringified = json.dumps(message)
    websocket.send(stringified)
    logger.debug(f"sent message: {stringified}")


def socket_listener(websocket):
    """listens for messages from the socket server"""
    for message in websocket:
        logger.debug(f"receive message: {message}")
        payload = json.loads(message)

        if payload["type"] == "warp_to_line":
            file = payload["file"]
            line = payload["line"]

            py_exec(f"renpy.warp_to_line('{file}:{line}')")

        elif payload["type"] == "set_autoreload":
            script = textwrap.dedent("""
                if renpy.get_autoreload() == False:
                    renpy.set_autoreload(True)
                    renpy.reload_script()
            """)
            py_exec(script)

        elif payload["type"] == "jump_to_label":
            label = payload["label"]

            script = textwrap.dedent(f"""
                if renpy.context_nesting_level() > 0:
                    renpy.jump_out_of_context('{label}')
                else:
                    renpy.jump('{label}')
            """)

            py_exec(script)

        else:
            logger.warning(f"unhandled message type '{payload['type']}'")


def socket_producer(websocket):
    """produces messages to the socket server"""
    from websockets.exceptions import ConnectionClosed  # type: ignore

    send = functools.partial(socket_send, websocket=websocket)

    # report current line to warp server
    def fn(event, interact=True, **kwargs):
        if not interact:
            return

        if event == "begin":
            filename, line = renpy.exports.get_filename_line()
            relative_filename = Path(filename).relative_to('game')
            filename_abs = Path(renpy.config.gamedir, relative_filename)

            message = {
                "type": "current_line",
                "line": line,
                "path": filename_abs.resolve().as_posix(),
                "relative_path": relative_filename.resolve().as_posix(),
            }

            try:
                send(message)
            except ConnectionClosed:
                # socket is closed, remove the callback
                renpy.config.all_character_callbacks.remove(fn)

    renpy.config.all_character_callbacks.append(fn)

    def label_callback(name, abnormal):
        try:
            send({"type": "current_label", "label": name})
        except ConnectionClosed:
            # socket is closed, remove the callback
            renpy.config.label_callbacks.remove(label_callback)

    renpy.config.label_callbacks.append(label_callback)

    send({"type": "list_labels", "labels": list(renpy.exports.get_all_labels())})


def socket_service(port, version, checksum):
    """connects to the socket server. returns True if the connection has completed its lifecycle"""
    # websockets module is bundled with renpy on versions >=8.2.0
    from websockets.sync.client import connect  # type: ignore
    from websockets.exceptions import (  # type: ignore
        WebSocketException,
        ConnectionClosedOK,
        ConnectionClosedError
    )

    logger.debug(f"try port {port}")

    try:
        headers = {
            "pid": str(os.getpid()),
            "warp-project-root": Path(renpy.config.gamedir).parent.resolve().as_posix(),
            "warp-version": version,
            "warp-checksum": checksum,
        }

        if os.getenv("WARP_WS_NONCE"):
            headers["warp-nonce"] = os.getenv("WARP_WS_NONCE")

        with connect(
            f"ws://localhost:{port}",
            additional_headers=headers,
            open_timeout=None,
            close_timeout=5,
        ) as websocket:
            quitting = False

            def quit():
                nonlocal quitting
                quitting = True
                logger.info(f"closing websocket connection :{port}")
                websocket.close(4000, 'renpy quit')

            renpy.config.quit_callbacks.append(quit)

            logger.info(f"connected to renpy warp socket server on :{port}")
            py_exec("renpy.notify(\"Connected to Ren'Py Launch and Sync\")")

            socket_producer(websocket)
            socket_listener(websocket)  # this blocks until socket is closed

            logger.info(f"socket service on :{port} exited")

            if not quitting:
                py_exec(
                    "renpy.notify(\"Disconnected from  Ren'Py Launch and Sync\")")

    except ConnectionClosedOK:
        logger.info(f"socket service on :{port} was terminated by server")
        pass

    except ConnectionClosedError as e:
        logger.info("connection replaced, service exiting")
        return True

    except WebSocketException as e:
        logger.exception("unexpected websocket error", exc_info=e)

    except (ConnectionError, TimeoutError) as e:
        logger.debug(
            f"{e.__class__.__name__}: could not establish connection to socket server")

    return False


def try_socket_ports_forever():
    version, checksum = get_meta()
    service_closed = False

    while service_closed is False:
        for port in range(40111, 40121):
            service_closed = socket_service(
                port=port, version=version, checksum=checksum)

            if service_closed:
                break

        if service_closed:
            break

        logger.debug(
            "exhausted all ports, waiting 3 seconds before retrying")
        sleep(3)

    logger.info("service closed")


def start_renpy_warp_service():
    if renpy.config.developer:
        renpy_warp_thread = threading.Thread(
            target=try_socket_ports_forever, daemon=True)
        renpy_warp_thread.start()

        logger.info(
            "service thread started. periodically scanning ports for warp server")


def declassify():
    """
    removes `renpy_warp_*.rpe{.py}` from build

    on renpy 8.3 and later, this is automatically done by the renpy build system
    """

    classify = renpy.python.store_dicts["store.build"]["classify"]
    classify("game/renpy_warp_*.rpe", None)
    classify("game/renpy_warp_*.rpe.py", None)


renpy.game.post_init.append(declassify)
renpy.config.display_start_callbacks.append(start_renpy_warp_service)
