# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](http://semver.org/).

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
