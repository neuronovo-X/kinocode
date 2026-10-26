// @ts-check
/**
 * The system's own folder and file dialogs, opened by Studio for a page in a browser (which can never learn a path):
 * the export's "Save to", and the media pane's "Import" and "Link" (pickFiles). The desktop app opens its own folder
 * dialog instead (lib/host.ts `folders.pick`).
 *
 *   macOS     osascript, `choose folder` / `choose file`, asked of Finder: a dialog of osascript's own opens behind
 *             the browser (macOS lets no background program bring itself forward), so it seems nothing happened. The
 *             first time, macOS asks once to let Studio's program control Finder; the app that was in front comes back
 *             when the dialog closes.
 *   Windows   PowerShell. For a folder, Explorer's own dialog (IFileOpenDialog in its folder mode: large, resizable,
 *             with the address bar and Quick access; the old Windows Forms tree only where that one cannot open). For
 *             files, the Windows Forms file dialog. Each is owned by a window of no size shown in front of everything,
 *             or it would open behind the browser. The script goes to PowerShell encoded, so nothing of the page's
 *             words can be read as part of it.
 *   Linux     zenity, else kdialog
 *
 * The page's words and the folder it starts in reach the dialog as arguments or environment variables, never inside
 * the script, so nothing typed can run as code.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

/**
 * osascript's lines (`-e` each) for a dialog Finder opens in front, `lines` setting `picked`; the app that was in
 * front is brought back after, picked or not. @param {string[]} lines
 */
function finderDialog(lines) {
  return [
    'on run argv',
    'set frontApp to (path to frontmost application as text)',
    /* the folder to start in, made here: Finder can't make a path one (-1700), and one that is gone opens none */
    'set startAt to missing value',
    'if (item 2 of argv) is not "" then',
    'try',
    'set startAt to (POSIX file (item 2 of argv)) as alias',
    'end try',
    'end if',
    'try',
    'tell application "Finder"',
    'activate',
    ...lines,
    'end tell',
    'on error message number n',
    'tell application frontApp to activate',
    'error message number n',
    'end try',
    'tell application frontApp to activate',
    'return picked',
    'end run',
  ].flatMap((line) => ['-e', line]);
}

/* A window of no size, off the screen, in front of everything: a dialog it owns opens in front of the browser too. */
const WIN_OWNER = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$w = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; FormBorderStyle = "None"; StartPosition = "Manual"; Opacity = 0 }',
  '$w.Location = New-Object System.Drawing.Point(-32000, -32000); $w.Size = New-Object System.Drawing.Size(1, 1)',
  '$w.Show(); $w.Activate(); [System.Windows.Forms.Application]::DoEvents()',
];


/* Keeps a dialog in front for its first seconds: a browser that takes the focus back once the dialog is up (or a window
   that is itself always on top) would leave it behind. The dialog is found by its class and title, then put above every
   window, topmost too, and given the focus (the thread input of the window in front is joined for the moment, which is
   what lets a program that is not in front take it). After that the person is left alone to look elsewhere. */
const WIN_FRONT_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class OpenFilmFront {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int how);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static void Front(IntPtr h) {
    uint pid; uint other = GetWindowThreadProcessId(GetForegroundWindow(), out pid); uint me = GetCurrentThreadId();
    bool joined = other != 0 && other != me && AttachThreadInput(me, other, true);
    if (IsIconic(h)) ShowWindow(h, 9);
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (joined) AttachThreadInput(me, other, false);
  }
  public static void Watch(string title, int milliseconds) {
    var thread = new Thread(() => {
      for (int i = 0; i < milliseconds / 80; i++) {
        IntPtr h = FindWindowW("#32770", title);
        if (h != IntPtr.Zero && GetForegroundWindow() != h) Front(h);
        Thread.Sleep(80);
      }
    });
    thread.IsBackground = true; thread.Start();
  }
}
`;

/* Explorer's folder dialog: IFileOpenDialog with its folder option (FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM |
   FOS_PATHMUSTEXIST). Sets $path to the folder, or leaves it empty when cancelled. */
const WIN_FOLDER_DIALOG = String.raw`
Add-Type -TypeDefinition @'
${WIN_FRONT_CS}
public static class OpenFilmFolder {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr types);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, int place);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IntPtr items);
    void GetSelectedItems(out IntPtr items);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
  interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem item);
    void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem item, uint hint, out int order);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);
  public static string Pick(string title, string start, IntPtr owner) {
    var dialog = (IFileOpenDialog)new FileOpenDialog();
    uint options; dialog.GetOptions(out options);
    dialog.SetOptions(options | 0x20 | 0x40 | 0x800);
    dialog.SetTitle(title);
    if (!string.IsNullOrEmpty(start)) {
      try { var iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"); IShellItem item; SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out item); dialog.SetFolder(item); } catch { }
    }
    OpenFilmFront.Watch(title, 4000);
    int result = dialog.Show(owner);
    if (result == unchecked((int)0x800704C7)) return null;
    if (result != 0) throw Marshal.GetExceptionForHR(result);
    IShellItem picked; dialog.GetResult(out picked);
    string path; picked.GetDisplayName(0x80058000, out path);
    return path;
  }
}
'@
$path = [OpenFilmFolder]::Pick($env:OPENFILM_PICK_TITLE, $env:OPENFILM_PICK_AT, $w.Handle)
`;

/* The old Windows Forms folder tree, for a computer where Explorer's dialog could not open. */
const WIN_FOLDER_FALLBACK = [
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = $env:OPENFILM_PICK_TITLE; $d.UseDescriptionForTitle = $true',
  'if ($env:OPENFILM_PICK_AT) { $d.SelectedPath = $env:OPENFILM_PICK_AT }',
  '$path = $null; if ($d.ShowDialog($w) -eq [System.Windows.Forms.DialogResult]::OK) { $path = $d.SelectedPath }',
];

/**
 * PowerShell is given the script encoded (UTF-16, base64): no character of it is ever read as a quote or a switch.
 * @param {string[]} lines @param {Record<string, string>} env
 */
const winCommand = (lines, env) => {
  const script = lines.join('\n');
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env, script };
};

/**
 * How to open the dialog here: the program, its arguments and the environment it adds; null when this system has none.
 * On Windows also the script itself (`script`), as PowerShell is given it encoded.
 * @param {NodeJS.Platform} platform @param {{ title: string, at?: string | null }} ask @param {(name: string) => boolean} [has]
 * @returns {{ cmd: string, args: string[], env?: Record<string, string>, script?: string } | null}
 */
export function folderPickerCommand(platform, { title, at }, has = () => true) {
  const start = at && isAbsolute(at) ? at : '';
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: [...finderDialog([
        'if startAt is missing value then',
        'set picked to POSIX path of (choose folder with prompt (item 1 of argv))',
        'else',
        'set picked to POSIX path of (choose folder with prompt (item 1 of argv) default location startAt)',
        'end if',
      ]), title, start],
    };
  }
  if (platform === 'win32') {
    return winCommand([
      // Match execFile's UTF-8 decoding, including paths outside the Windows console code page.
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding',
      ...WIN_OWNER,
      '$path = $null',
      'try {',
      WIN_FOLDER_DIALOG,
      '} catch {',
      ...WIN_FOLDER_FALLBACK,
      '}',
      'if ($path) { [Console]::Out.Write($path) }',
    ], { OPENFILM_PICK_TITLE: title, OPENFILM_PICK_AT: start });
  }
  if (has('zenity')) {
    return { cmd: 'zenity', args: ['--file-selection', '--directory', `--title=${title}`, ...(start ? [`--filename=${start}/`] : [])] };
  }
  if (has('kdialog')) return { cmd: 'kdialog', args: ['--getexistingdirectory', start || '.', '--title', title] };
  return null;
}

/**
 * How to open the dialog that picks files (several at once): the program, its arguments and the environment it adds;
 * null when this system has none. It prints one path a line.
 * @param {NodeJS.Platform} platform @param {{ title: string, at?: string | null }} ask @param {(name: string) => boolean} [has]
 * @returns {{ cmd: string, args: string[], env?: Record<string, string>, script?: string } | null}
 */
export function filePickerCommand(platform, { title, at }, has = () => true) {
  const start = at && isAbsolute(at) ? at : '';
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: [...finderDialog([
        'if startAt is missing value then',
        'set chosen to choose file with prompt (item 1 of argv) with multiple selections allowed',
        'else',
        'set chosen to choose file with prompt (item 1 of argv) default location startAt with multiple selections allowed',
        'end if',
        'set picked to ""',
        'repeat with f in chosen',
        'set picked to picked & POSIX path of f & linefeed',
        'end repeat',
      ]), title, start],
    };
  }
  if (platform === 'win32') {
    return winCommand([
      // Match execFile's UTF-8 decoding, including paths outside the Windows console code page.
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding',
      ...WIN_OWNER,
      `Add-Type -TypeDefinition @'${WIN_FRONT_CS}'@`,
      '[OpenFilmFront]::Watch($env:OPENFILM_PICK_TITLE, 4000)',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      '$d.Title = $env:OPENFILM_PICK_TITLE',
      '$d.Multiselect = $true',
      'if ($env:OPENFILM_PICK_AT) { $d.InitialDirectory = $env:OPENFILM_PICK_AT }',
      'if ($d.ShowDialog($w) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write(($d.FileNames -join "`n")) }',
    ], { OPENFILM_PICK_TITLE: title, OPENFILM_PICK_AT: start });
  }
  if (has('zenity')) {
    return { cmd: 'zenity', args: ['--file-selection', '--multiple', '--separator=\n', `--title=${title}`, ...(start ? [`--filename=${start}/`] : [])] };
  }
  if (has('kdialog')) return { cmd: 'kdialog', args: ['--getopenfilename', start || '.', '--multiple', '--separate-output', '--title', title] };
  return null;
}

/**
 * Whether a dialog that gave nothing was cancelled: osascript says error -128 (any other error exits 1 too: Finder
 * not allowed, -1743, is a failure, and the page lets the person type the path), zenity and kdialog exit 1, Windows
 * prints nothing. @param {string} cmd @param {import('node:child_process').ExecFileException | null} error
 */
export function cancelled(cmd, error) {
  if (!error) return true;
  if (/-128\b|User canceled/i.test(String(error.message))) return true;
  return cmd !== 'osascript' && error.code === 1;
}

/**
 * Where a dialog starts: the folder asked, or the nearest folder above it that is there (an exports folder is made
 * by the first export); none when nothing of it is. @param {string | null | undefined} at
 * @param {(path: string) => boolean} [exists]
 */
export function startFolder(at, exists = existsSync) {
  if (!at || !isAbsolute(at)) return null;
  for (let dir = at; ; dir = dirname(dir)) {
    if (exists(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The folder a dialog printed: without a slash at its end, but the root of a disk keeps its own (D:\ is the disk's
 * folder, D: only the folder that disk was last in, and no full path). @param {string | Buffer} output
 */
export function folderPath(output) {
  const text = String(output).trim();
  if (/^[A-Za-z]:[\\/]*$/.test(text)) return `${text.slice(0, 2)}\\`;
  return text.replace(/[\\/]+$/, '') || (text === '/' ? '/' : '');
}

/** What went wrong, as the dialog's own program said it (its first line), else the error's. @param {string | Buffer} stderr @param {Error} error */
const why = (stderr, error) => String(stderr).split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 300) || error.message;

/** Whether a program is on the PATH (Linux: which dialog there is). @param {string} name */
const onPath = (name) => (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(`${dir}/${name}`));

/**
 * Ask the person for a folder. Resolves its path, or null when they cancelled; rejects when this system has no dialog
 * Studio can open (the page lets them type one then).
 * @param {{ title: string, at?: string | null }} ask @returns {Promise<string | null>}
 */
export function pickFolder(ask) {
  const command = folderPickerCommand(process.platform, { ...ask, at: startFolder(ask.at) }, onPath);
  if (!command) return Promise.reject(new Error('no folder dialog on this system'));
  return new Promise((resolve, reject) => {
    execFile(command.cmd, command.args, { env: { ...process.env, ...command.env }, encoding: 'utf8', windowsHide: false, timeout: 15 * 60_000 }, (error, stdout, stderr) => {
      const path = folderPath(stdout);
      if (path) { resolve(path); return; }
      if (cancelled(command.cmd, error)) { resolve(null); return; }
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') { reject(new Error('no folder dialog on this system')); return; }
      reject(new Error(why(stderr, /** @type {Error} */ (error))));
    });
  });
}

/**
 * Ask the person for files. Resolves their paths (none when they cancelled); rejects when this system has no dialog
 * Studio can open.
 * @param {{ title: string, at?: string | null }} ask @returns {Promise<string[]>}
 */
export function pickFiles(ask) {
  const command = filePickerCommand(process.platform, { ...ask, at: startFolder(ask.at) }, onPath);
  if (!command) return Promise.reject(new Error('no file dialog on this system'));
  return new Promise((resolve, reject) => {
    execFile(command.cmd, command.args, { env: { ...process.env, ...command.env }, encoding: 'utf8', windowsHide: false, timeout: 15 * 60_000 }, (error, stdout, stderr) => {
      const paths = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && isAbsolute(line));
      if (paths.length) { resolve(paths); return; }
      if (cancelled(command.cmd, error)) { resolve([]); return; }
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') { reject(new Error('no file dialog on this system')); return; }
      reject(new Error(why(stderr, /** @type {Error} */ (error))));
    });
  });
}
