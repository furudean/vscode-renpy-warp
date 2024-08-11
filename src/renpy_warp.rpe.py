# This file is created by the Ren'Py Launch and Sync Visual Studio Code
# extension. It can be safely be deleted if you do not want to use the features
# provided by the extension.
#
# This file should not be checked into source control.
#

import renpy  # type: ignore
from time import sleep
import textwrap
import threading
import json
import functools
import re
import os


def get_meta():
    RPE_FILE_PATTERN = re.compile(
        r"renpy_warp_(?P<version>\d+\.\d+\.\d+)(?:_(?P<checksum>[a-z0-9]+))?\.rpe(?:\.py)?")

    filename = os.path.basename(__file__)
    match = RPE_FILE_PATTERN.match(filename)

    if not match:
        raise Exception(
            f"could not parse filename '{filename}'"
            f" with pattern '{RPE_FILE_PATTERN.pattern}'")

    d = match.groupdict()

    return d["version"], d["checksum"]


def py_exec(text: str):
    while renpy.exports.is_init_phase():
        print("in init phase, waiting...")
        sleep(0.2)

    fn = functools.partial(renpy.python.py_exec, text)
    renpy.exports.invoke_in_main_thread(fn)


def socket_listener(websocket):
    """listens for messages from the socket server"""
    for message in websocket:
        payload = json.loads(message)

        print("socket <", message)

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

        elif payload["type"] == "reload":
            py_exec("renpy.reload_script()")
            break

        else:
            print(f"unhandled message type '{payload['type']}'")


def socket_producer(websocket):
    """produces messages to the socket server"""

    first = True

    # report current line to warp server
    def fn(event, interact=True, **kwargs):
        nonlocal first

        if not interact:
            return

        if event == "begin":
            # skip the first event, as it usually is not useful
            if first:
                first = False
                return

            filename, line = renpy.exports.get_filename_line()
            relative_filename = re.sub(r"^game/", "", filename)
            filename_abs = os.path.join(
                renpy.config.gamedir, relative_filename)

            message = json.dumps(
                {
                    "type": "current_line",
                    "line": line,
                    "path": filename_abs,
                    "relative_path": relative_filename,
                }
            )

            print("socket >", message)
            websocket.send(message)

    renpy.config.all_character_callbacks.append(fn)


def connect(port):
    # websockets module is bundled with renpy
    from websockets.sync.client import connect  # type: ignore
    from websockets.exceptions import WebSocketException, ConnectionClosedOK  # type: ignore

    try:
        version, checksum = get_meta()
        headers = {
            "pid": str(os.getpid()),
            "warp-project-root": re.sub(r"/game$", "", renpy.config.gamedir),
            "warp-version": version,
            "warp-checksum": checksum,
        }

        if os.getenv("WARP_WS_NONCE"):
            headers["warp-nonce"] = os.getenv("WARP_WS_NONCE")

        with connect(
            f"ws://localhost:{port}",
            additional_headers=headers,
            open_timeout=5,
            close_timeout=5,
        ) as websocket:
            def quit():
                print("closing websocket connection")
                websocket.close()

            renpy.config.quit_callbacks.append(quit)

            socket_producer(websocket)
            socket_listener(websocket)  # this blocks until socket is closed

    except ConnectionClosedOK:
        print("connection closed by renpy warp socket server")
        pass

    except WebSocketException as e:
        print("websocket error:", e)

    except ConnectionRefusedError:
        print(f"socket connection refused on :{port}")


def try_ports():
    while True:
        for port in range(40111, 40121):
            connect(port)

        print("exhausted all ports, waiting 5 seconds before retrying")
        sleep(5)


@ functools.lru_cache(maxsize=1)  # only run once
def start_renpy_warp_service():
    if renpy.config.developer:
        renpy_warp_thread = threading.Thread(target=try_ports, daemon=True)
        renpy_warp_thread.start()

        print("renpy warp thread started")


def declassify():
    """removes `renpy_warp_*.rpe` from build"""
    print("adding renpy_warp_*.rpe to classify blacklist")

    classify = renpy.python.store_dicts["store.build"]["classify"]
    classify("game/renpy_warp_*.rpe", None)


renpy.game.post_init.append(start_renpy_warp_service)
renpy.game.post_init.append(declassify)
