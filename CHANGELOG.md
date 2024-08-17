# Changelog

All notable changes to this project will be documented in this file.

## 1.15.0 - 2024-08-17

-   Add option to hide some notifications, which can be reset with the command
    `renpyWarp.resetSupressedMessages`
-   Consistency improvements to `renpyWarp.followCursorOnLaunch`
-   Allow processes launched with the extension to stay open... kind of
-   Now logs process output to a log file instead of via pipe
-   Buffer IPC messages until the socket is ready

## 1.14.4 - 2024-08-16

-   fix `renpyWarp.setAutoReloadOnSave` not working

## 1.14.3 - 2024-08-16

-   Resolve symlinks when syncing editor to line
-   Stability improvements for socket pick up and hangup

## 1.14.2 - 2024-08-12

-   Fix socket not being reconnected on game reload

## 1.14.1 - 2024-08-12

-   Fix handling of RPE metadata in 8.2, which made the socket server not
    connect
-   Resolve symlinked paths when discovering an external Ren'Py process

## 1.14.0 - 2024-08-12

-   External Ren'Py processes can now be picked up by the extension, allowing
    you to work with Ren'Py projects that are not opened through Visual Studio
    Code.
-   Renpy Extensions will not be updated on extension activation (if enabled)
    instead of only on launch. This is to facilitate the above use case.
-   The socket server now starts when the extension is activated, rather than
    when a game is launched. This is configurable via the new setting
    `renpyWarp.autoStartSocketServer`
-   The commands `renpyWarp.startSocketServer` and `renpyWarp.stopSocketServer`
    have been added to manually start and stop the socket server respectively
-   `renpyWarp.socketPorts` has been removed, now using a static list of ports
-   Fix auto save feature not working if `renpy` was not a registered language.
    Now simply checks if the filename ends with `.rpy`

## 1.13.0 - 2024-08-06

-   Renpy Launch and Sync RPE files in the game directory will now be excluded
    from the build using `build.classify` (Thanks to @brunoais for figuring
    out how to do this)

## 1.12.0 - 2024-08-05

-   The option `renpyWarp.followCursorExecInterval` has been removed. The operation is now instantaneous.
-   Removes dependency on the deprecated `LuqueDaniel.languague-renpy` and refactor features that depended on it.

## 1.11.0 - 2024-07-28

-   A less intrusive notification will now be shown when a warp occurs in an open window
-   Now relies on a random number to identify the process calling back to the extension than using a pid.
    This is necessary in case renpy was not opened through forking (E.g. editor in flatpak)
    by @brunoais
-   Split different process outputs into different output channels

## 1.10.0 - 2024-07-24

-   The RPE now dynamically imports the `websockets` module to avoid errors in
    web (https://github.com/furudean/vscode-renpy-warp/issues/26)
-   The service will now only start if `config.developer` is set to `True`

## 1.9.0 - 2024-07-23

-   The RPE would be installed every time a process was launched, even if it was
    already installed because of an oversight in the expression that captures the version.

## 1.8.13~14 - 2024-07-23

-   Now also published on the Open VSX registry

## 1.8.12 - 2024-07-22

-   Reverts CI/CD pipeline changes

## 1.8.1~11 - 2024-07-22

-   Trying to fix the CI/CD pipeline but was unsuccessful

## 1.8.0 - 2024-07-22

-   Remove notifications for warping in open window
-   Adds a 'Show' button when .rpe is installed manually
-   Append a hash to the .rpe file so that the file only updates when the
    contents change
-   Fix some inaccuracies with settings documentation
-   Enable auto reloading of the game when a game file first is saved with the
    setting `renpyWarp.setAutoReloadOnSave` enabled.
-   ~~This extension is now also published on the Open VSX registry~~

## 1.7.2 - 2024-07-15

-   Fix a bug where follow cursor would be enabled when a process was closed

## 1.7.1 - 2024-07-15

-   Handles cancelation state more gracefully

## 1.7.0 - 2024-07-15

-   Now supports sync features multiple Ren'Py instances, only affecting the
    process that was most recently opened

## 1.6.0 - 2024-07-14

-   `renpyWarp.renpyExtensionsEnabled` is now a tri-state setting, with the
    default being `Unset`. The user will be prompted to set this setting when
    launching a game for the first time.
-   Use a quick pick for the extension selection

## 1.5.0 - 2024-07-13

-   Pin a supported version of `glob`
-   Refactor of data plumbing. Less dependencies on classes and less duplicate
    calls. Things should overall be a bit faster.

## 1.4.1 - 2024-07-11

-   Fixes a few bugs that broke the extension on Windows. Sorry about that!

## 1.4.0 - 2024-07-11

-   Improve first time setup experience by prompting the user to set the Ren'Py
    SDK path and direct to additional settings
-   Install the .rpe.py file in the SDK root on version 8.3.0 and above

## 1.3.0 - 2024-07-09

-   Migrate source code to TypeScript
-   Don't link to specific settings (it doesn't work very well)
-   You can no longer start the extension with `renpyWarp.toggleFollowCursor`
-   Say what process an output line was from
-   Redo the notifications. They're cancellable now!
-   Warp to file is now the title action, as this seems to be what people expect
-   Many bugs were found and fixed along the way, but I'm not sure if they're
    worth mentioning.
-   Overhaul socket handling. Now supports many Visual Studio Code workspaces!
    As a result of this, the setting `renpy.webSocketsPort` was replaced with
    `renpy.socketPorts`, which is an array of ports to try to connect to. The
    first one that works will be used.

## 1.2.0 - 2024-07-06

-   Leave the websocket server running for a bit if connection is lost, like on
    a reload or a crash
-   Close old socket if the same process tries to connect more than once

## 1.1.1~4 - 2024-07-06

Testing some CI stuff, no actual code changes

## 1.1.0 - 2024-07-05

-   Don't attempt to modify .gitignore as we can't know what the user wants
-   Add `renpyWarp.focusWindowOnWarp` back.

## 1.0.1 - 2024-07-05

-   Fix a bug where extension would not initialize properly on Windows. As a
    side effect, the `renpyWarp.focusWindowOnWarp` setting is removed for now,
    as the dependency for it has environment specific bindings that I won't have
    time to fix for a while.
-   Match pid to child process, as Windows Ren'Py creates a subprocesses that
    doesn't match what was expected

## 1.0.0 - 2024-07-04

This release is a major overhaul of the extension internally, signifiying a 1.0
release. Yay!

-   Implements a new protocol for communication between the extension and
    Ren'Py, which uses a WebSocket server in Ren'Py to communicate with the
    extension. The largest motivation for this change is that the `exec.py`
    feature was canned on grounds of being a footgun.
    -   The new protocol supports a wider variety of Ren'Py versions. Let me know
        if you find a version that doesn't work!
    -   Adds a new setting, `renpyWarp.websocketPort`, to control the port the
        websockets server should listen on.
    -   A new setting, `renpyWarp.renpyExtensionsEnabled` has been added to
        control whether or not the extension should attempt to communicate with
        Ren'Py.
-   Removes the 'Auto' strategy for `renpyWarp.strategy`, as it is no longer
    necessary with the new protocol. The new default is 'Update Window'.
-   Launch scripts have been removed. Use a `.rpe` file in your project to get
    the same effect.

## 0.26.0 - 2024-07-01

-   Implements a task queue for exec.py commands, which should prevent things
    from happening out of order
-   Removes retries on sync script injection, as it's no longer necessary with
    the task queue

## 0.25.3 - 2024-07-01

-   Adds retries on editor sync script injection. It should now be able to
    recover better.
-   The sync script itself has a better check for duplicates, checking if the
    function exists in the list before adding it.
-   Removes duplicate redundancy checks added in 0.25.1~2, as they are now
    obsolete

## 0.25.2 - 2024-06-30

-   Fix somewhat erroneous behavior introduced in 0.26.1. Now instead relies on
    the previous warp spec to deduplicate a sync

## 0.25.1 - 2024-06-30

-   Fix redundant editor sync on window reload

## 0.25.0 - 2024-06-30

-   Improves the reliabilty of the _Follow Cursor_ feature by re-injecting the
    script when Ren'Py is reloaded
-   Only conditionally inject the script if it's not already present, avoiding
    redundant injections
-   The _Follow Cursor_ button now only appears if the feature is supported
-   Adds a new setting, `renpyWarp.followCursorOnLaunch`, to control whether or
    not the cursor should follow by default
-   Add OK button to notifications that did not have one

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
