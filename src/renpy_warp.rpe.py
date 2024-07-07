# This file is created by the Ren'Py Launch and Sync Visual Studio Code
# extension. It can be safely be deleted if you do not want to use the features
# provided by the extension.
#
# This file should not be checked into source control.
#

from time import sleep
import renpy  # type: ignore
from websockets.sync.client import connect
import websockets

import threading
import json
import functools
import re
import os

port = os.getenv("WARP_WS_PORT")


def py_exec(text: str):
    while renpy.exports.is_init_phase():
        print("in init phase, waiting...")
        sleep(0.5)

    fn = functools.partial(renpy.python.py_exec, text)
    renpy.exports.invoke_in_main_thread(fn)


def socket_listener(websocket: websockets.WebSocketClientProtocol):
    """listens for messages from the socket server"""
    for message in websocket:
        payload = json.loads(message)

        print("socket >", message)

        if payload["type"] == "warp_to_line":
            file = payload["file"]
            line = payload["line"]
            py_exec(f"renpy.warp_to_line('{file}:{line}')")

        else:
            print(f"unhandled message type '{payload['type']}'")


def socket_producer(websocket: websockets.WebSocketClientProtocol):
    """produces messages to the socket server"""

    # report current line to warp server
    def fn(event, interact=True, **kwargs):
        if not interact:
            return

        if event == "begin":
            filename, line = renpy.exports.get_filename_line()
            relative_filename = re.sub(r"^game/", "", filename)
            filename_abs = os.path.join(renpy.config.gamedir, relative_filename)

            message = json.dumps(
                {
                    "type": "current_line",
                    "line": line,
                    "path": filename_abs,
                    "relative_path": relative_filename,
                }
            )

            print("socket <", message)
            websocket.send(message)

    renpy.config.all_character_callbacks.append(fn)


def renpy_warp_service():
    try:
        with connect(
            f"ws://localhost:{port}",
            additional_headers={"pid": str(os.getpid())},
            open_timeout=5,
            close_timeout=5,
        ) as websocket:
            print("connected to renpy warp socket server")

            renpy.config.quit_callbacks.append(lambda: websocket.close())

            socket_producer(websocket)
            socket_listener(websocket)  # this blocks until socket is closed

    except websockets.exceptions.ConnectionClosedOK:
        print("connection closed by renpy warp socket server")
        pass

    except websockets.exceptions.ConnectionClosedError as e:
        print("connection to renpy warp socket server closed unexpectedly", e)
        sleep(1)
        return renpy_warp_service()

    except ConnectionRefusedError:
        print(f"no renpy warp socket server on {port}. retrying in 1s...")
        sleep(1)
        return renpy_warp_service()

    print("renpy warp script exiting")


if port:
    renpy_warp_thread = threading.Thread(target=renpy_warp_service)
    renpy_warp_thread.daemon = True
    renpy_warp_thread.start()

    print("renpy warp script started")
