# Ren'Py Warp to Line

Open your Ren'Py game at the current line or file in the editor.

## Commands

| Command                | Description                     | Shortcut                                     | Shortcut (Mac)                             |
| ---------------------- | ------------------------------- | -------------------------------------------- | ------------------------------------------ |
| `renpyWarp.warpToLine` | Open Ren'Py at the current line | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> |
| `renpyWarp.warpToFile` | Open Ren'Py at the current file | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> |
| `renpyWarp.launch`     | Launch the Ren'Py project       | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> | <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> |

## Triggers

1. By using title bar run menu ![](images/tab_bar.png)
2. By using the right click context in an editor ![](images/editor_context.png)
3. By using the right click context menu in the file explorer
   ![](images/explorer_context.png)
4. By opening the command palette and typing the command, i.e.
   `Renpy: Open Ren'Py at current line`
5. Via keyboard shortcut ([see here](#commands))

## Configuration

You must set <code codesetting="renpyWarp.sdkPath">renpyWarp.sdkPath</code> to a
path where a Ren'Py SDK can be found. If you haven't done so, a prompt will appear
to inform you to set it.

## Troubleshooting

In order to use the current line/file feature, your game must be compatible with
warping as described in [the Ren'Py
documentation](https://www.renpy.org/doc/html/developer_tools.html#warping-to-a-line).
This feature has several limitations that you should be aware of, and as such may not
work in all cases.

## Attribution

The icon for this extension is a cropped rendition of the Ren'Py mascot, Eileen,
taken from [the Ren'Py website](https://www.renpy.org/artcard.html).
