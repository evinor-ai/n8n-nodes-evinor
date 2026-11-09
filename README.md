# Evinor nodes for n8n

This is an [n8n](https://n8n.io/) community node package. It starts n8n workflows from
[Evinor](https://evinor.ai) sensors, which watch for real-world events such as layoffs, funding
rounds and acquisitions.

- [Installation](#installation)
- [Credentials](#credentials)
- [Usage](#usage)
- [Output](#output)
- [Security and delivery behavior](#security-and-delivery-behavior)
- [Troubleshooting](#troubleshooting)
- [Example workflow](#example-workflow)
- [Development](#development)
- [Releasing](#releasing)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and install `@evinor/n8n-nodes-evinor`.

**Your n8n instance must be reachable over public HTTPS.** Evinor delivers events by calling n8n's
webhook URL, and its delivery path blocks private and loopback addresses, so a localhost or LAN
instance cannot receive deliveries. Connecting one fails with the API's message, "The URL must be
reachable over public HTTPS." If you self-host behind a proxy or tunnel, set n8n's `WEBHOOK_URL` to
the public address.

## Credentials

Create an **Evinor API** credential:

| Field    | Value                                                                                                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Key  | An Evinor API key with the `SENSORS_READ` and `SENSORS_WRITE` scopes.                                                                                                                                           |
| Base URL | Leave as `https://api.evinor.ai` unless you are testing another environment. **Warning:** this field also accepts plain `http://`, which sends your API key in cleartext. Use `http://` only for local testing. |

`SENSORS_READ` lists your sensors and `SENSORS_WRITE` connects and disconnects the workflow. n8n
tests the credential by calling `GET /v1/sensors`.

## Usage

Add **Evinor Trigger** to a workflow, select the credential and pick a **Sensor** from the list, or
switch to **By ID** to use an ID or an expression. A disabled sensor is listed with a note. You can
connect to it, and it delivers once enabled.

| In n8n                | What the node does                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Listen for test event | Asks Evinor to send one sample event to n8n's test URL. Evinor allows 5 of these per account per 10 minutes. |
| Activate workflow     | Connects the workflow's production URL to the sensor as an n8n destination.                                  |
| Deactivate workflow   | Disconnects that destination. A destination that is already gone counts as success.                          |
| Each delivery         | Verifies the signature, key id and timestamp, then runs the workflow, or answers 401 without running it.     |

If Evinor rejects a connection, n8n shows Evinor's own error message.

## Output

By default each item is the event's full `payload` plus three fields:

| Field            | Meaning                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `messageId`      | The ID of this delivery attempt. A retry gets a new one.                     |
| `idempotencyKey` | The same for every attempt of one delivery. Use it to deduplicate.           |
| `isTest`         | `true` for a sample event from **Listen for test event**, otherwise `false`. |

Turn on **Simplify** to get `payload.details` at the top level, with the same three fields and with
roles flattened:

```json
{
	"templateCodeName": "LAYOFF",
	"generatedSentence": "TechCorp laid off 200 people.",
	"roles": {
		"COMPANY_NAME": "TechCorp",
		"AFFECTED_EMPLOYEES_COUNT": "200 people"
	},
	"parsedValues": {
		"AFFECTED_EMPLOYEES_COUNT": { "parsedAmount": 200 }
	},
	"messageId": "4ba21e4c-e3a9-7684-ad83-5467af61a24f",
	"idempotencyKey": "delivery-golden-1",
	"isTest": false
}
```

A role that has several values, such as two companies, becomes an array in `roles` and
`parsedValues`.

## Security and delivery behavior

**Verification.** The node checks each delivery's HMAC-SHA256 signature in constant time, requires
the key id it was issued, and rejects a timestamp more than 5 minutes from now in either direction.
Any failure answers 401 and does not run the workflow.

**Replays and duplicates.** A delivery replayed inside the 5-minute window passes verification and
runs the workflow again, and Evinor can also retry a delivery. The node does not deduplicate. If
repeats matter, deduplicate on `idempotencyKey`, for example with n8n's Remove Duplicates node. A
`messageId` catches an exact replay but not a retry, because each attempt gets a new one.

**Where the signing secret is stored.** The secret is kept in the workflow's static data. n8n stores
static data in plain text in its database and in workflow exports. It is not covered by
`N8N_ENCRYPTION_KEY`, unlike credentials. Treat database backups and exported workflows as sensitive.
The node never writes the secret to its output or logs.

**Reactivating mints a new secret.** Deactivating and reactivating a workflow connects again and
issues a new signing secret. If an earlier deactivation never reached Evinor, for example because
n8n crashed, the new connection replaces the old destination for that URL. The old destination's ID
stops existing, and its delivery history stays under the old ID.

Only a connection to the same URL replaces the old destination. If the webhook URL changes, for
example after a new `WEBHOOK_URL`, the old destination keeps delivering to the old URL until you
remove it in Evinor. If n8n crashes after connecting but before it saves the workflow's static data,
deliveries are rejected until you reactivate the workflow.

## Troubleshooting

**A test event was rejected.** Test deliveries are not retried, so one that is occasionally rejected
is not sent again. Click **Listen for test event** again to request a new one.

## Example workflow

Replace the sensor ID, then import this into n8n:

```json
{
	"name": "Evinor sensor example",
	"nodes": [
		{
			"parameters": {
				"sensor": { "__rl": true, "mode": "id", "value": "YOUR_SENSOR_ID" },
				"simplify": true
			},
			"id": "4f1f6f0e-4d3a-4a6f-9a57-0d5a6f3c1a01",
			"name": "Evinor Trigger",
			"type": "@evinor/n8n-nodes-evinor.evinorTrigger",
			"typeVersion": 1,
			"position": [0, 0],
			"webhookId": "2f3cf6d1-9b0a-4f0e-8a51-6f7c2d1e4b02"
		},
		{
			"parameters": {},
			"id": "7a2d9c34-1e5b-4c7d-b6f8-3e9a1c5d7f03",
			"name": "Handle event",
			"type": "n8n-nodes-base.noOp",
			"typeVersion": 1,
			"position": [240, 0]
		}
	],
	"connections": {
		"Evinor Trigger": {
			"main": [[{ "node": "Handle event", "type": "main", "index": 0 }]]
		}
	}
}
```

## Development

Requires Node.js 24 and npm 11.5.1 or newer.

```bash
npm ci
npm run lint
npm test     # builds, then runs the tests with node --test
npm run dev  # starts a local n8n with this node linked
```

The package has no runtime dependencies.

## Releasing

Releases are published only by the `publish.yml` GitHub Action. **Do not run `npm run release` or
`n8n-node release` on your machine, and do not run `npm publish`.**

1. Open a normal PR to `main` that:
   - [ ] bumps `version` in `package.json` and `package-lock.json`;
   - [ ] updates `CHANGELOG.md` by hand (nothing generates it).
2. After it merges, an admin tags the merged commit and pushes the tag:

   ```bash
   git tag v0.1.0 <merged-commit-sha>
   git push origin v0.1.0
   ```

3. CI verifies that the tag equals `v` + the `package.json` version and that the commit is on `main`,
   then publishes to npm with provenance through Trusted Publishing.

## License

[MIT](LICENSE.md)
