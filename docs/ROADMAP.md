# Roadmap

Opportunities noted on 19 November 2026 after building game review, repertoire comparison and
settings, roughly in order of value. Move an item out of this list when it ships.

1. **Ground the companion's prose in the board: shipped, with more to do.** The companion now gets
   computed facts with every turn and engine result (`server/facts.ts`). On the first eval run
   (12 questions from three games, one run per model) false board claims fell from 11 to 3 across
   GPT-6 Luna, GPT-6.1 Terra and GPT-6.1 Sol while the models made twice as many attack and defence
   claims. Still open:
   - Repeat the eval on more games and more than one run per model; the numbers are small.
   - The facts describe single moves. Threats two moves deep ("…Nb4 threatens …Nc2+") and
     defence claims are where the remaining errors are.
   - Reconsider the default model: Luna made no false claim with facts at a twentieth of Sol's cost.
2. **Make game review faster.** A 47-move game took 72 seconds the first time and the accuracy
   table stays empty until the end.
   - Show a running accuracy while the pass is in progress.
   - Search positions in parallel instead of one at a time.
   - Compute the second line (needed for Great) only on moves that matched the engine's choice.
3. **List the opponent moves the repertoire has no answer to.** Opponents leave the repertoire
   first in a third to a half of games; those moves are counted but not listed, and they are the
   most direct guide to what to prepare next.
4. **Look across games, not just within one.** From the games already fetched: accuracy by
   opening, where mistakes cluster (opening, middlegame, endgame, time control), recurring
   blunder patterns.
5. **Let the user try moves on the review board.** It is read-only, so "what if I had played this"
   has to go through the companion. A sideline to play out, with the engine and companion
   following, is the most natural missing interaction.
6. **Export the repertoire.** Changes can be accepted from proposals and from the player's own
   habits, but there is no PGN export, so nothing flows back to where the repertoire is studied.
7. **Use the clock.** chess.com's PGNs carry move times, which are discarded. Time spent per move
   would explain many mistakes.

Smaller items:

- **Missing labels:** the review has no Brilliant or Miss labels.
- **Untested UI:** there are no automated tests for the React screens; a small Playwright suite
  would catch the kind of bug so far found only by driving the browser by hand.
