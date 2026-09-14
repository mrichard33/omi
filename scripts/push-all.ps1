# push-all.ps1 — push every Reece Omi worktree, in one go.
#
# The Reece work is spread over three checkouts (see docs/reece-fork.md), and
# the failure this exists to prevent is the quiet one: you push the worktree you
# happen to be standing in, assume you are done, and lose an afternoon's work in
# the other two when the machine is rebuilt.
#
# `git push --all` pushes every LOCAL branch, which is what you want here —
# these worktrees carry work on several branches at once and remembering which
# is which is exactly the thing that goes wrong at the end of a long day.
#
# Usage, from anywhere:
#   pwsh -File scripts/push-all.ps1
#   pwsh -File scripts/push-all.ps1 -Root D:\src -DryRun

[CmdletBinding()]
param(
    # Where the three worktrees live. Defaults to the parent of this repo.
    [string] $Root,

    # List what would be pushed and push nothing.
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
    $Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

$worktrees = @('omi', 'omi-win-fixes', 'omi-ptt-budget')

$failed = @()
$pushed = @()
$missing = @()

foreach ($name in $worktrees) {
    $path = Join-Path $Root $name

    if (-not (Test-Path (Join-Path $path '.git'))) {
        # Not every machine has all three. Say so and carry on — stopping here
        # would mean the worktrees after it never get pushed either.
        Write-Host "skip  $name  (not at $path)" -ForegroundColor DarkGray
        $missing += $name
        continue
    }

    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    Push-Location $path
    try {
        $status = git status --short
        if ($status) {
            # Uncommitted work is not pushed, and you should know that before
            # you close the laptop.
            Write-Host 'uncommitted changes (NOT pushed):' -ForegroundColor Yellow
            $status | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
        }

        if ($DryRun) {
            Write-Host 'would run: git push --all origin' -ForegroundColor DarkGray
            git branch --format='    %(refname:short)'
        }
        else {
            git push --all origin
            if ($LASTEXITCODE -ne 0) { throw "git push exited $LASTEXITCODE" }
            # Tags are how the Windows release is cut, so they travel too.
            git push --tags origin
            if ($LASTEXITCODE -ne 0) { throw "git push --tags exited $LASTEXITCODE" }
            Write-Host "pushed $name" -ForegroundColor Green
            $pushed += $name
        }
    }
    catch {
        # One bad remote must not stop the other two.
        Write-Host "FAILED $name : $_" -ForegroundColor Red
        $failed += $name
    }
    finally {
        Pop-Location
    }
}

Write-Host "`n--- summary ---"
if ($pushed)  { Write-Host "pushed:  $($pushed -join ', ')" -ForegroundColor Green }
if ($missing) { Write-Host "missing: $($missing -join ', ')" -ForegroundColor DarkGray }
if ($failed)  {
    Write-Host "FAILED:  $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
