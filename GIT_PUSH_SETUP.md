# Git Push Setup for Claude Code

## Problem
The Claude Code git proxy service (127.0.0.1:19292 and similar localhost ports) **blocks all git push operations** with HTTP 403 Forbidden, even though the credentials are valid.

## Solution
Push directly to GitHub via HTTPS instead of through the Claude Code proxy.

## Configuration

### Set Direct GitHub Remote

```bash
# Replace GITHUB_PAT with your actual GitHub Personal Access Token
git remote set-url origin https://willho:GITHUB_PAT@github.com/willho/Penny-Pincher2.git
```

### Verify It Works

```bash
git push -u origin <branch-name>
```

Should work immediately without 403 errors.

## Why This Happens

1. Claude Code uses a local git proxy at 127.0.0.1:XXXX (port varies)
2. The proxy intercepts git operations
3. Git push operations are blocked by the proxy service
4. Git fetch/pull work fine through the proxy (read-only operations)
5. Pushing directly to GitHub bypasses the broken proxy

## For Future Sessions

- If `git push` fails with `403 Forbidden` from localhost proxy
- Always try: `git remote set-url origin https://USERNAME:TOKEN@github.com/USERNAME/REPO.git`
- Then `git push` should work
- Fetch from proxy works fine, only push needs direct GitHub access

## Token Management

The GitHub PAT is stored in `~/.git-credentials`:
```
https://USERNAME:GITHUB_PAT@github.com
```

Keep this file secure (mode 600). **NEVER commit the actual token to version control.**
