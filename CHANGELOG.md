# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

-   Improves the reliabilty of the _Follow Cursor_ feature by re-injecting the
    script when Ren'Py is reloaded
-   Only conditionally inject the script if it's not already present, avoiding
    infinite recursion

## 0.24.0 - 2024-06-20

-   Overhaul of the _Follow Cursor_ feature, now can sync the cursor to the
    Ren'Py window. This is configurable via `renpyWarp.followCursorMode` and by
    default is set to "Ren'Py updates Visual Studio Code". The old behavior can
    be restored by setting it to "Visual Studio Code updates Ren'Py".

## 0.23.0 - 2024-06-16

-   Bump packages
-   Launches the game if not open when `renpyWarp.toggleFollowCursor` is
    activated

## 0.22.0 - 2024-06-12

-   Fixes a bug where `renpyWarp.launchToFile` would always open a new window
    regardless of the setting of `renpyWarp.strategy`
-   Clean up exec.py event handlers a bit more gracefully
-   Increase timeout for exec.py to 5 seconds
-   Don't attempt launch script if it's not supported, regardless of setting

## 0.21.0 - 2024-05-26

-   Adds a setting `renpyWarp.focusWindowOnWarp` to control whether or not the
    Ren'Py window should be focused is focused when warping occurs

## 0.20.0 - 2024-05-22

-   Raises the timeout for the `exec.py` feature test to 1 second

## 0.19.0 - 2024-05-22

-   Adds post-launch scripts via `renpyWarp.launchScript`, allowing you to run
    Python scripts after launching the game (On Ren'Py 8.3.0+)

## 0.18.0 - 2024-05-21

-   Now sniffs for the Ren'Py version with `renpy.sh` instead of `exec.py` to
    determine what features are available
-   The progress bar has been made more accurate in Ren'Py versions >=8.3.0, by
    utilizing an optional check for `exec.py` script

## 0.17.0 - 2024-05-15

-   Clean up the `exec.py` file if feature test fails

## 0.16.0 - 2024-05-11

-   Tell users what Ren'Py version they need.
-   `exec.py` writes are now atomic, as recommended by the Ren'Py documentation
-   Waits 200ms for execution instead of 500ms

## 0.15.0 - 2024-05-03

-   Log process output to a separate channel than extension output
-   Change status bar text strings to be capitalized similar to other extensions
-   Cursor follow now says "Following Cursor" instead of "Stop Following Cursor"

## 0.14.0 - 2024-04-20

-   Handle errors more gracefully
-   Instead of calculating a non-unique hash, use a timestamp to make the
    `exec.py` signature

## 0.13.0 - 2024-04-18

-   Improve detection of consumed `exec.py` files by reading to and writing
    stdout
-   Improved logging

## 0.12.0 - 2024-04-16

-   No changes, just a version bump since the 0.11.0 was a pre-release

## 0.11.0 - 2024-04-16

-   The extension is now called Ren'Py Launch and Sync
-   `renpyWarp.strategy` has had its values updated for clarity. The new values
    are `Auto`, `New Window`, `Replace Window`, and `Update Window`.
    `Replace Window` is new, allowing you to choose whether or
    not to kill the process when a new command is issued.
-   Test for `exec.py` support no longer cleans up the file it creates if it
    doesn't exist. Only Ren'Py should consume this file, otherwise the extension
    can confuse itself.
-   Machine-specific settings like `renpyWarp.sdkPath` will no longer sync with
    VSCode's settings sync feature
-   Stop using `chokidar` for watching files in favor of a more vanilla approach
-   Numerous clarifications and improvements in documentation

## 0.10.2 - 2024-04-11

-   Minor fixes to settings docs
-   Fix an invalid link to a setting on an error message

## 0.10.1 - 2024-04-11

-   Fix some edge cases with the cursor sync feature

## 0.10.0 - 2024-04-11

-   Adds a feature to sync the cursor in script to the Ren'Py window

## 0.9.0 - 2024-04-10

-   Implements Ren'Py's `exec.py` to dynamically warp into an already open
    process. `renpyWarp.strategy` controls whether or not this is enabled.
-   Kills the process with a slightly harsher SIGKILL, which bypasses the "are
    you sure" dialog on games
-   Improved process management across the board
-   Adds `renpyWarp.killAll`, which will kill all running Ren'Py instances
-   End the `renpyWarp.advancedProgressBars` experiment. The code burden was too
    high for this feature. It is perhaps better served via `exec.py` in the
    future.

## 0.8.1 - 2024-04-06

-   Fixes a few small bugs relating to error handling, leading to the extension
    sometimes getting stuck in weird states

## 0.8.0 - 2024-04-04

-   Improve handling for processes, which updates the status bar in real time.
    Once started, the status bar will change to reflect that, and you can also
    quit the game from this menu. This is powered by a new undocumented command,
    `launchOrQuit`, which is not meant to be called directly.
-   To commands that aren't associated with the status bar, a notification will
    show until the process is launched
-   Adds an experimental setting, `renpyWarp.advancedProgressBars` which
    will enhance notifications when Ren'Py is starting. It waits for your game
    to output something to stdout when it's considered "ready". Ren'Py does not
    do this by default, so this feature will be opt-in for now.
-   Deletes the old extension icon from the repository

## 0.7.0 - 2024-03-29

-   Add a button to reopen the game with the same parameters if it crashes
-   Use `fsPath` instead of `path` when finding the project path (via
    [#1](https://github.com/furudean/vscode-renpy-warp/pull/1), thanks
    @SirFlobo!)

## 0.6.0 - 2024-03-28

-   Status bar has 0 priority now, so it should show up at the end of the status
    bar.

## 0.5.0 - 2024-03-28

-   Using commands will update the spinner in the status bar to indicate that the
    command is running. (Though it's slightly faked)

## 0.4.1 - 2024-03-27

-   Minor documentation updates

## 0.4.0 - 2024-03-27

-   Fix configuration title in `package.json`
-   Introduces the setting `renpyWarp.editor` to specify the editor to use when
    pressing <kbd>Shift</kbd>+<kbd>E</kbd> in Ren'Py. Equivalent to setting the
    [environment variable `RENPY_EDIT_PY`](https://www.renpy.org/doc/html/editor.html).

## 0.3.1 - 2024-03-27

-   Fix syntax for `RENPY_EDIT_PY` on Windows

## 0.3.0 - 2024-03-27

-   Fix incorrect icon on the `renpyWarp.warpToFile` command.
-   Allow `renpyWarp.launch` to be called for a workspace folder context
-   Add a status bar button for the `renpyWarp.launch` command
-   Set [`RENPY_EDIT_PY`](https://www.renpy.org/doc/html/editor.html) to point
    at the system Visual Studio Code, allowing <kbd>Shift</kbd>+<kbd>E</kbd> to
    open the current line from Ren'Py.

## 0.2.0 - 2024-03-27

-   Updated the README, documenting some troubleshooting steps.
-   Refactor, shouldn't be any user-facing changes.
-   Change the icon for the command `warpToFile`

## 0.1.1 - 2024-03-27

The icon for the extension has been updated to be an official rendition of
Eileen, the Ren'Py mascot.

## 0.1.0 - 2024-03-26

initial public release. yay!
