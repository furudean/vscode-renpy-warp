# Change Log

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](http://semver.org/).

## Unreleased

-   Add a button to reopen the game with the same parameters if it crashes

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
