# Changelog

Update this file by hand in every version-bump PR. See "Releasing" in the README.

## 0.2.0

- Simplify now keeps `eventCodeName`, `eventDate` and `externalEventId` from the payload. Before,
  Simplify dropped them, so a simplified item had no event date and no event type at the top level.
  Existing fields are unchanged; this only adds fields.

## 0.1.0

First release.

- Evinor Trigger node: starts a workflow when an Evinor sensor matches an event.
- Evinor API credential.
- Verifies every delivery's signature, key id and timestamp.
- Optional Simplify output.
