#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Compile, package and install cs-md-docs into the VS Code on this machine.

.DESCRIPTION
    One command between an edit and a working extension. Runs the parser unit
    tests first, so a broken build cannot reach the editor, then packages a VSIX
    and installs it over whatever is there.

    The end-to-end suite is deliberately not run here: it launches VS Code twice
    and waits for Roslyn, which is minutes rather than seconds. Run `npm run
    test:e2e` when the change touches the hover pipeline.

.PARAMETER SkipTests
    Compile only. For when the tests were just run and the loop is the point.

.PARAMETER NoInstall
    Stop after the VSIX is written. Useful for producing an artifact to hand
    somewhere else.

.PARAMETER Code
    Path to Code.exe or its bin/code.cmd. Defaults to $env:CSMD_VSCODE, then the
    usual install locations. Point it at Insiders to deploy there instead.

.EXAMPLE
    ./scripts/deploy.ps1
.EXAMPLE
    npm run deploy -- -SkipTests
#>
[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$NoInstall,
    [string]$Code
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# A terminal inside VS Code inherits ELECTRON_RUN_AS_NODE=1, and the CLI wrapper
# sets it for itself. Leaving an inherited one in place makes every Electron
# process spawned from here boot as plain Node. Same trap runTests.ts clears.
$env:ELECTRON_RUN_AS_NODE = $null

# Native commands do not throw, and $PSNativeCommandUseErrorActionPreference has
# moved between versions. Checking the code explicitly is one line and does not
# depend on which PowerShell is running the script.
function Invoke-Step {
    param([string]$What, [scriptblock]$Body)
    Write-Host "-> $What" -ForegroundColor Cyan
    & $Body
    if ($LASTEXITCODE -ne 0) {
        throw "$What failed with exit code $LASTEXITCODE"
    }
}

<#
.SYNOPSIS
    The VS Code command line, which is not Code.exe.

.DESCRIPTION
    Code.exe is the GUI entry point; passing it --install-extension detaches and
    returns success before the install has happened. bin/code.cmd is the wrapper
    that runs the CLI in-process and reports a real exit code, so that is what
    gets called. $env:CSMD_VSCODE is accepted in either form, and in both the
    same variable the test runner uses.
#>
function Resolve-CodeCli {
    param([string]$Hint)

    # A path someone typed is an instruction, not a suggestion. Falling through to
    # whatever is on PATH would deploy to a different editor than the one asked
    # for and report success, which is the worst available outcome.
    $explicit = if ($Hint) { $Hint } else { $env:CSMD_VSCODE }
    $candidates = @(
        $explicit
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe')
        'C:\Program Files\Microsoft VS Code\Code.exe'
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        # Existence is tested before Split-Path, which throws on an unmapped drive
        # under ErrorActionPreference Stop and would replace the message below
        # with "Cannot find drive".
        if (Test-Path $candidate) {
            $cli = if ($candidate -like '*.cmd') {
                $candidate
            }
            else {
                Join-Path (Split-Path -Parent $candidate) 'bin\code.cmd'
            }
            if (Test-Path $cli) { return $cli }
        }
        if ($candidate -eq $explicit) {
            throw "no VS Code CLI at the path given: $candidate"
        }
    }

    # Last resort, and the one that works on a checkout that is not Windows.
    $onPath = Get-Command code -CommandType Application -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    throw "no VS Code CLI found, tried:`n  $($candidates -join "`n  ")"
}

Push-Location $root
try {
    $manifest = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $id = "$($manifest.publisher).$($manifest.name)"
    $vsix = Join-Path $root "$($manifest.name)-$($manifest.version).vsix"

    if ($SkipTests) {
        Invoke-Step 'compile' { npm run compile }
    }
    else {
        Invoke-Step 'compile and unit tests' { npm test }
    }

    # --no-install so a missing devDependency is an error rather than a silent
    # download of whatever vsce is newest today.
    Invoke-Step "package $([System.IO.Path]::GetFileName($vsix))" {
        npx --no-install vsce package --out $vsix
    }

    if ($NoInstall) {
        Write-Host "`nPackaged, not installed: $vsix" -ForegroundColor Green
        return
    }

    $cli = Resolve-CodeCli -Hint $Code
    Write-Host "   CLI: $cli" -ForegroundColor DarkGray

    # --force is not optional: the version in package.json rarely changes between
    # deploys, and without it the CLI treats an equal version as already
    # installed and exits 0 having done nothing at all.
    Invoke-Step "install $id" {
        & $cli --install-extension $vsix --force
    }

    Write-Host "`n$id $($manifest.version) installed." -ForegroundColor Green
    Write-Host 'Reload the window to pick it up: Ctrl+Shift+P, Developer: Reload Window.' -ForegroundColor Yellow
}
finally {
    Pop-Location
}
