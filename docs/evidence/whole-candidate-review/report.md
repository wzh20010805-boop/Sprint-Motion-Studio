# Whole-action human review

The desktop review screen now offers `确认整个动作并允许导出`. A human who has inspected the current final sequence and playback can record both approvals with one confirmation per action. Individual frame review remains available for repairs.

The server records authoritative desktop reviewer identity, candidate content and playback hashes, and all final-frame receipts in one transaction. It requires the selected, submitted candidate, current review revision, complete self-check, intact candidate files, no unresolved blocking issues, and no frames marked for repair. Acceptance starts the existing tool delivery operation. Maker sessions have no approval route or substitute archive path.

## Verification

- Focused tests covered reviewer authority, explicit confirmation, hashes, revision conflicts, partial-to-whole approval, replay, revocation, repair/blocking issues, and HTTP anonymous/maker/context rejection plus desktop reviewer success. All three scenarios passed across the focused runs.
- `bun run typecheck` completed with exit code 0 after the frontend fixture was added.
- The hidden Electron probe rendered the new button and an actual frozen final frame from the production candidate. The button was enabled, no console errors were reported, and the probe performed zero review writes. See `ui-verified/ui.json` and `ui-verified/ui.png`.
- Independent review found no important concrete defect in the approval transaction and authority checks.
- A normal desktop window opened the existing six-project production workspace with the new build. Launch evidence is in `production/character-20261014/v2/review-ready-2e9abf95-77e8-4731-9ca2-0dece6aecdb9.json` relative to the parent workspace.

## Production state at verification

The six selected candidates still had no recorded frame or playback approval. The export orchestrator reported them as pending and generated no official archives. It will only copy and verify archives produced by their accepted tool delivery operations. The user's completed visual inspection is acknowledged; the remaining desktop confirmation records that inspection without requiring 822 separate clicks.
