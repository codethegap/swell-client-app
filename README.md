# FlexiPort Client App

A Swell app that imports store data (products, categories, customers, orders) from a FlexiPort.ai pipeline into a Swell store, with durable resumable imports and automatic image rehosting to the Swell CDN.

## Install

Prerequisites: [Bun](https://bun.sh) (or Node.js 22+) and the Swell CLI.

```bash
npm install -g @swell/cli
```

1. Log in to the target Swell store:

   ```bash
   swell login
   ```

2. Install dependencies (from this directory):

   ```bash
   bun install
   ```

3. Deploy the app to the store:

   ```bash
   swell app push
   ```

## Usage

After deployment, open the Swell dashboard and find the **FlexiPort.ai** section. Create a new import, paste your FlexiPort pipe access key, and save. Once the file list has synced, enable **Start Importing** and save again. Progress and any ignored records are shown per file on the import record.

## Development

```bash
swell app dev        # local dev tunnel against the test environment
npm run typecheck    # TypeScript checks
npm test             # unit + integration tests (uses your Swell CLI session)
```
