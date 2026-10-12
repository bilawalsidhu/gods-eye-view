# Local camera and street image workflow

Save a camera snapshot to open its preview. The original remains separate from marked, cropped, locally enhanced and generated downloads. Local region crop, contrast and sharpening run on the device; they cannot recover missing pixels.

**ASK AI** explicitly sends the original plus normalized marks and a lossless server crop for a selected region to `gpt-6.1-sol` with high reasoning. Responses should explain visible evidence, plausible make/model/year ranges and uncertainty. Enhanced/generated pixels never corroborate identification. No person, plate, re-identification or model fallback is supported. API charges are separate from the reconstruction allowance.

**AI RECONSTRUCTION** explicitly sends a whole original or selected crop to `gpt-image-2.5-flare`, one low-quality 1024-square output. It can invent detail and is visibly labeled AI-generated, not evidence. Outside a selected region the original is retained. Key presence alone never enables paid generation.

## Explicit owner allowance

After approving the provider cost, initialize a private allowance yourself:

```sh
node scripts/approve-image-allowance.mjs --approve-cost --limit-usd 1
```

Use `--prior-spend-usd` to include known earlier charges. The script refuses an existing policy; never reset a ledger to bypass spending history. Set `GEV_IMAGE_GENERATION_POLICY` in your ignored environment to the absolute policy path (default `.gev-private/image-generation-policy.json`), then restart. A server-side OpenAI API key and model access are separately required.

Each sent attempt permanently allocates $0.10. With a $1 limit and no prior spend this permits at most ten attempts. Reported token costs are shown separately. The persisted ledger serializes sends and fails closed for missing/corrupt state, unknown charges and stale reservations. Cancellation cannot recall a sent request. This is a conservative app-side allocation estimate, not an OpenAI invoice or account-wide ceiling; Q&A and voice costs are separate. Keep policies and ledgers private and retain them across restarts/upgrades.

## Street imagery

In **STREET LEVEL**, paste a public Mapillary link or numeric ID and choose **VIEW MAPILLARY PHOTO**. The official embed retains provider credits; **CLOSE PHOTO** releases it. The external provider link remains available if embedding fails. Public website visibility does not establish API access; actual provider image rendering is network/access dependent and has not been verified in this environment. Google Street View uses the supported external link.
