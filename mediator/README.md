# Mediator - Universal Web Access Service

A lightweight service that executes JavaScript code on websites, enabling Claude (or any client) to access sites that are normally blocked or JavaScript-heavy.

## What It Does

When Claude encounters a website that:
- Returns 403/host blocked errors
- Requires JavaScript rendering
- Has dynamic content loaded client-side

Instead of being blocked, Claude can:
1. Write JavaScript code to extract the data
2. Send it to this Mediator service
3. Get back the results
4. Answer your question

## Usage

### Start the Service

```bash
npm install
npm start
```

Server runs on `http://localhost:3000`

### Make a Request

```bash
curl -X POST http://localhost:3000/execute \
  -H "Authorization: Bearer your-auth-token" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://solscan.io/tokens",
    "code": "return document.querySelectorAll(\"table tbody tr\").length"
  }'
```

### Response

```json
{
  "success": true,
  "result": 1247,
  "url": "https://solscan.io/tokens"
}
```

## API Endpoints

### `POST /execute`

Execute JavaScript on a website.

**Auth**: Bearer token required

**Body**:
```json
{
  "url": "https://example.com",
  "code": "return document.title"
}
```

**Returns**:
```json
{
  "success": true,
  "result": "Any JSON-serializable value",
  "url": "https://example.com"
}
```

### `GET /health`

Health check.

```bash
curl http://localhost:3000/health
```

### `GET /`

API info and documentation.

## Code Execution Context

Your JavaScript code has access to:
- `document` - DOM API
- `window` - Window object
- `navigator` - Navigator object
- Standard async/await
- Any standard JavaScript features

### Examples

**Count elements**:
```javascript
return document.querySelectorAll('tr').length
```

**Extract text**:
```javascript
return Array.from(document.querySelectorAll('[data-token]'))
  .map(el => el.textContent.trim())
```

**Parse JSON from page**:
```javascript
return JSON.parse(window.__DATA__)
```

**Wait for content to load**:
```javascript
// Wait for selector to appear (handled by navigation)
return document.querySelectorAll('.loaded').length
```

## Environment Variables

Create a `.env` file (copy from `.env.example`):

```bash
# Server port (Replit sets this automatically)
PORT=3000

# IMPORTANT: Change this to a secure token
AUTH_TOKEN=change-me-to-something-secure

# How long to let JavaScript run (milliseconds)
EXECUTION_TIMEOUT=30000

# Environment
NODE_ENV=production
```

## Deployment on Replit

1. Create new Replit project from this repository
2. Replit automatically sets `PORT` environment variable
3. In `.env`, set `AUTH_TOKEN` to something secure (or keep for testing)
4. Click "Run" - server starts and gets a public URL
5. Share the URL + token with Claude or your app

Example Replit URL: `https://mediator.username.replit.dev`

## Security Considerations

⚠️ **Important**:
- Change `AUTH_TOKEN` before production use
- The service can execute arbitrary JavaScript
- Only share the token with trusted clients
- Consider rate limiting for production
- Timeouts prevent infinite loops (30s default)

## How Claude Uses This

Once deployed, Claude can automatically:

```
User: "How many tokens launched on Solana in last 24 hours?"
  ↓
Claude detects Solscan is blocked
  ↓
Claude POSTs to mediator:
  { url: "https://solscan.io/tokens", code: "return document.querySelectorAll('tr').length" }
  ↓
Mediator returns: { result: 1247 }
  ↓
Claude answers: "1,247 tokens launched in the last 24 hours"
```

## Limitations

- JavaScript execution timeout: 30 seconds (configurable)
- Results must be JSON-serializable
- No persistent state between requests
- Browser opens fresh for each request (cookie-free)
- Large responses may be slow

## Troubleshooting

**"net::ERR_CERT_AUTHORITY_INVALID"**
- Some sites have SSL issues, script handles this

**Timeout errors**
- Code took too long, increase `EXECUTION_TIMEOUT` in `.env`
- Or optimize the code to be faster

**"Cannot read property X"**
- Selector not found or page structure different than expected
- Adjust CSS selectors in code

## Next Steps

1. Deploy to Replit
2. Test health endpoint: `GET /health`
3. Try sample request
4. Share URL + token with Claude
5. Claude will auto-use it when needed

## Development

```bash
# Install dependencies
npm install

# Run locally
npm start

# The server will be available at http://localhost:3000
```
