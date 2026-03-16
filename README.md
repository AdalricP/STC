# See thy commits

Chrome extension that injects a GitHub-style commit graph into repository pages on `github.com`.

## Features

- Public repositories load without authentication.
- Private repositories work with a saved GitHub personal access token.
- Graph panel is rendered directly on GitHub repository pages and stays close to the native dark commit-page look.

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this repository directory.

## Private repositories

1. Create a GitHub personal access token with repo read access.
2. Open the extension popup.
3. Save the token.

The token is stored with `chrome.storage.sync`.
