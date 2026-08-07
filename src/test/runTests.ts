import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Drives the integration suite twice against the VS Code that is actually
 * installed on this machine, not a downloaded build, so a pass means it works
 * here rather than in a clean-room approximation.
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const sampleWorkspace = path.resolve(extensionDevelopmentPath, 'sample');
  const vscodeExecutablePath = resolveVSCode();
  const scratch = path.join(os.tmpdir(), 'cs-md-docs-e2e');

  console.log(`VS Code: ${vscodeExecutablePath}`);

  // A terminal inside VS Code inherits ELECTRON_RUN_AS_NODE=1, which would make
  // the Code.exe we spawn boot as plain Node and treat the workspace folder as a
  // script to require. Node drops env entries whose value is undefined.
  const env = { ELECTRON_RUN_AS_NODE: undefined };

  const only = process.argv[2];

  // Pass 1: everything else off, so the only hover in the popup is ours.
  if (only !== 'roslyn') {
    await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: { ...env, CSMD_MODE: 'isolated' },
    launchArgs: [
      sampleWorkspace,
      '--disable-extensions',
      '--user-data-dir',
      path.join(scratch, 'user-isolated'),
      '--extensions-dir',
        path.join(scratch, 'ext-isolated'),
      ],
    });
  }

  // Pass 2: the real C# extension alongside, to prove the two hovers compose.
  if (only !== 'isolated') {
    const extensionsDir = path.join(scratch, 'ext-roslyn');
    linkInstalledExtensions(extensionsDir, [
      'ms-dotnettools.csharp',
      'ms-dotnettools.vscode-dotnet-runtime',
    ]);
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { ...env, CSMD_MODE: 'roslyn' },
      launchArgs: [
        sampleWorkspace,
        '--user-data-dir',
        path.join(scratch, 'user-roslyn'),
        '--extensions-dir',
        extensionsDir,
      ],
    });
  }
}

function resolveVSCode(): string {
  const candidates = [
    process.env.CSMD_VSCODE,
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`no VS Code found, tried:\n  ${candidates.join('\n  ')}`);
  }
  return found;
}

/**
 * Junction the installed extensions into a throwaway extensions directory.
 * Copying would be a few hundred megabytes, and pointing the test instance at
 * the real directory would let it rewrite state the editor depends on.
 */
function linkInstalledExtensions(target: string, ids: readonly string[]): void {
  const source = path.join(os.homedir(), '.vscode', 'extensions');
  fs.mkdirSync(target, { recursive: true });
  for (const id of ids) {
    const match = fs
      .readdirSync(source)
      .find((entry) => entry.toLowerCase().startsWith(`${id.toLowerCase()}-`));
    if (!match) {
      throw new Error(`${id} is not installed under ${source}`);
    }
    const link = path.join(target, match);
    if (!fs.existsSync(link)) {
      fs.symlinkSync(path.join(source, match), link, 'junction');
    }
    console.log(`linked ${match}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
