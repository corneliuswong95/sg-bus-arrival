# Design decisions

A short, dated log of notable product/design decisions and reversals — the "why"
behind changes that aren't obvious from the code alone. Newest first.

## 2026-08-01 — "Your buses" board kept to a single clean line

**Decision:** The "Your buses" board (`#next-board` / `renderNextBoard`) shows only
**route bullet · destination · countdown** per row. Crowding level and bus type are
**not** shown on the board.

**What was tried:** A second, subtle line was added under each destination showing
the crowding bar + word (`crowdHtml`) and the double-decker/bendy glyph
(`busTypeIcon`), laid out with CSS grid so it hung beneath the destination and
collapsed when a bus reported neither.

**Why reverted:** It made the board look cluttered and uneven — rows with crowding
data were taller than rows without, and the extra line fought with the board's job
of being a glanceable LED departure readout. The board should stay a calm, single
line per service; density belongs on the arrival cards, not the hero board.

**Still available:** Crowding and bus type remain on the **arrival cards** below
(`svcLiveHtml` → `crowdHtml` + `busTypeIcon`), where there's room for detail. The
`crowdHtml` / `busTypeIcon` helpers are unchanged and still used there.

**Kept from the same round of work** (these were separate, and stay):
- Board **re-sort FLIP animation**, **odometer digit roll** (Web Animations API,
  cancellation-safe so the 10s tick and 30s fetch can't strand a digit), number
  **glow bloom**, row **enter/leave**, and the update **light-sweep**.
- Arrival-card LED **split-flap flip** on minute change.
- Arrivals list sorts by **natural service number only** — favourites are no longer
  floated to the top there, because the board already surfaces them. (Favourite
  *stops* still sort first in the "Bus stops" nearby list and search.)
