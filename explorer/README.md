# Trade Bot Explorer v0.2

A local-first visual research workspace for audited WDO candles. Researchers can draw price references, select a historical movement, write a structured retrospective assessment, and share records through an explicitly authorized Supabase project.

This is research tooling—not signal generation, strategy validation, replay, backtesting, execution, or evidence of profitability.

## Run locally

```powershell
cd explorer
npm ci
npm test
npm run dev
```

Use the local URL printed by Vite. Build and preview the static bundle with:

```powershell
npm run build
npm run preview
```

The application opens on a dedicated email/password authentication screen. The chart, candle loader, drawing tools, and analysis history are initialized only after Supabase restores a session and the user is found in `research_members`. An authenticated account outside that allowlist sees a restricted-access screen and can sign out.

## Update audited private candle data

From the repository root:

```powershell
python scripts/audit_candles.py
python scripts/export_explorer.py --contract WDOV26 --dates 2026-09-14 2026-09-15 2026-09-16 2026-09-17 2026-09-18 2026-09-21
```

The exporter writes the unchanged compact JSON schema to the ignored local staging directory `data/explorer_storage/`. Its object layout mirrors the private bucket:

```text
manifest.json
WDOV26/2026-09-14.json
WDOV26/2026-09-15.json
WDOV26/2026-09-16.json
WDOV26/2026-09-17.json
WDOV26/2026-09-18.json
WDOV26/2026-09-21.json
```

Raw trades, filtered trades, audits, and staged candle JSON must never be placed under `explorer/public/`. Vite public-directory copying is disabled and the production build runs an additional check that rejects `dist/data`.

### Apply private Storage authorization

After applying the research migration, review and run [the private candle Storage migration](supabase/migrations/202609220002_private_candle_storage.sql) in the Supabase SQL editor. It creates or hardens the private `trade-bot-candles` bucket and grants authenticated object downloads only when `public.is_research_member()` succeeds. It creates no client upload, update, or delete policy.

Review existing policies in **Storage → Policies** as well. PostgreSQL RLS policies are permissive: an unrelated pre-existing broad policy on `storage.objects` could grant more access than this bucket-specific policy intends.

### Manual upload procedure

Uploads are deliberately administrative and manual; the frontend has no write policy or upload code.

1. In the Supabase Dashboard, open **Storage → trade-bot-candles** and confirm the bucket is private.
2. Create/open the `WDOV26` folder and upload the six staged daily JSON files from `data/explorer_storage/WDOV26/`. Preserve each filename and use `application/json`. Replace an existing object only when intentionally publishing a regenerated audited file.
3. Return to the bucket root and upload `data/explorer_storage/manifest.json` as `manifest.json` **after** every referenced daily object exists.
4. Confirm the Dashboard object paths exactly match the layout above. Do not create an extra `explorer_storage` or `data` prefix.

For future dates, rerun the exporter with the complete explicitly selected date set, upload new or changed daily objects first, and replace the root manifest last. The manifest-last order prevents clients from seeing a date before its object exists. To record the exact local inputs before upload:

```powershell
Get-ChildItem data/explorer_storage -File -Recurse |
  Sort-Object FullName |
  Get-FileHash -Algorithm SHA256
```

## Drawing model

Drawings use schema version `1` and store actual chart timestamps and prices, never pixels. Switching timeframes reprojects the same anchors and does not snap them to different candles.

- Horizontal line: one timestamp/price anchor; the price is rendered across the pane.
- Trend line: two ordered timestamp/price anchors.
- Rectangle: two opposite timestamp/price anchors.
- Fibonacci: two ordered timestamp/price anchors and a per-drawing level array. The initial levels are `0, 0.236, 0.382, 0.5, 0.618, 0.786, 1`.

Fibonacci uses `price = anchor1 + (anchor2 - anchor1) × level`. Reversing the anchors therefore reverses the retracement direction. The saved level array is part of each drawing.

Drawing tools are one-shot and return to Navigate mode after completion. Edit mode deliberately captures pointer input so anchors or the whole drawing can be dragged; return to Navigate mode for chart pan/zoom. Escape cancels unfinished work and returns to navigation.

## Retrospective research records

Movement selection snaps to displayed candle timestamps; drawings do not. A click selects one candle and a drag selects an interval. Records separate:

1. Observed contract/date/timeframe, selected timestamps, cutoff, and drawings.
2. Trader interpretation: pattern, direction, context, factors, and assessment.
3. Candidate automation hypothesis and its research status.

The analysis cutoff records the information the researcher intends to consider. It does not hide future candles or remove hindsight bias.

Chart timestamps are exchange-local wall-clock values projected into Unix seconds through UTC solely to preserve the chart's original displayed clock. They are not assertions about the source feed's timezone semantics.

## Supabase configuration

The frontend uses only these public browser variables:

```powershell
Copy-Item .env.example .env.local
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Never use a service-role key, secret key, database password, or management token in the frontend. `.env.local` and other local environment variants are ignored by Git.

### Required user setup

1. In Supabase Authentication → Providers, keep the Email provider enabled with password authentication. The Explorer does not call public sign-up; if accounts are provisioned separately, disable new-user sign-ups in the Dashboard as an additional safeguard.
2. Set the local Site URL or add `http://localhost:5173/` to the permitted Redirect URLs so password-recovery links can return to the Explorer. Add the final GitHub Pages project URL only after redistribution and deployment approval.
3. Review and run [the research migration](supabase/migrations/202609220001_research_annotations.sql), followed by [the private candle Storage migration](supabase/migrations/202609220002_private_candle_storage.sql), in the Supabase SQL editor.
4. Existing magic-link users should sign out, enter the same email address, and choose **Definir ou recuperar senha**. The recovery link updates that existing `auth.users` identity; it does not create a second account, change its user ID, or replace its `research_members` row.
5. New accounts must be provisioned through an explicitly controlled Supabase administration workflow before they can request recovery. Then add only the intended identities to `research_members` using the reviewed SQL at the bottom of the migration.
6. Review the project password policy and recovery-email template in the Dashboard. The Supabase policy remains authoritative; the frontend only confirms that both entered passwords match.
7. Sign in with the new password and confirm that the shared list loads for the authorized researcher.

Do not add a broad insert policy to `research_members`. The table is the explicit allowlist.

### Database authorization

- Anonymous users receive no table grants.
- A valid Supabase login alone is insufficient; every data policy also calls `is_research_member()`.
- Authorized members can read the allowlist and all shared research.
- Authorized members can create records only as themselves.
- Only the record author can edit or delete it. No administrator override is implemented.
- Drawings are embedded in their parent record's `jsonb`, so deleting a research record cannot leave orphaned drawings.
- `created_at`, `updated_at`, and `author_id` are enforced in the database.
- The `trade-bot-candles` bucket is private. Its object-download policy requires both an authenticated JWT and current membership in `research_members`.
- No anonymous candle reads or researcher-side Storage writes are granted.

## JSON research export

The current day's shared records can be downloaded as JSON. The export contains a top-level schema version, export timestamp, structured form fields, author identifiers returned by RLS, and complete drawing geometry. It does not contain candle data or credentials.

## Tests

```powershell
python -m unittest discover -s tests -v
cd explorer
npm test
npm run build
```

Frontend tests cover aggregation, drawing serialization and hit geometry, Fibonacci direction/calculation, research validation and database mapping, JSON export, authenticated Storage loading/error handling, production asset exclusion, and required RLS migration clauses.

## Deployment boundary

The repository includes a GitHub Pages workflow, but no deployment is performed merely by building locally. Public deployment of the application and any distribution of B3-derived history remain pending verification of applicable licensing and redistribution terms. Never publish `data/raw/`, `data/wdo/`, `data/audit/`, `data/candles/`, or `data/explorer_storage/`.

The static application bundle contains no candle manifest or daily candle JSON. Authorized browsers retrieve those objects through the authenticated Supabase Storage download endpoint, where Storage RLS makes the final access decision. The publishable key remains appropriate for the browser; never add a service-role key, secret key, database password, or Storage administration credential to frontend environment variables.

### GitHub Pages configuration

The project site is built for `https://pindinti.github.io/trader_bot/`. Development mode keeps Vite's `/` base so `npm run dev` continues to use `http://localhost:5173/`; production builds use `/trader_bot/`.

In **GitHub → Settings → Pages**, select **GitHub Actions** as the build source. In **Settings → Secrets and variables → Actions → Variables**, create these repository variables using the same browser-safe values as the local `.env.local`:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Do not create service-role or secret-key variables for this workflow. The workflow fails before building when either required public variable is empty.

In **Supabase → Authentication → URL Configuration**, set:

- Site URL: `https://pindinti.github.io/trader_bot/`
- Redirect URLs: `https://pindinti.github.io/trader_bot/` and `http://localhost:5173/`

The recovery redirect is derived from Vite's application base, so production callbacks return to `/trader_bot/` and local callbacks return to `/`. After the first deployment, manually verify session restoration, password recovery, membership denial, authorized private-candle loading, and sign-out at the production URL.
