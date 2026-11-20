# Roadmap

Opportunities noted on 19 November 2026 after building game review, repertoire comparison and
settings, roughly in order of value. Move an item out of this list when it ships.

1. **Make the companion explain ideas, not just moves.** Board facts shipped (`server/facts.ts`):
   the companion gets what each move takes, attacks, uncovers and leaves loose. The eval
   (`npm run eval`, 75 questions, one run per model at medium effort) says where that helped and
   where it did not:

   |                                                                | GPT-6 Luna | GPT-6.1 Terra | GPT-6.1 Sol |
   | -------------------------------------------------------------- | ---------- | ------------- | ----------- |
   | Tactics fully explained, without → with facts (of 20)          | 7 → 10     | 13 → 19       | 15 → 20     |
   | Answers with a false board claim, without → with facts (of 75) | 6 → 7      | 11 → 2        | 4 → 3       |
   | Positional reference points conveyed, without → with facts     | 12% → 6%   | 17% → 16%     | 26% → 21%   |

   A second run added Claude models (through the Claude bridge) and moved grading to Claude:
   Sonnet 5.5 extracts claims, Opus 5.5 judges. Same 75 questions, with facts, all six models
   graded alike:

   |                                                    | Luna    | Terra   | Sol    | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
   | -------------------------------------------------- | ------- | ------- | ------ | --------- | ---------- | -------- |
   | Tactics fully explained (of 20)                    | 12      | 20      | 20     | 15        | 18         | 19       |
   | Positional reference points conveyed               | 6%      | 10%     | 19%    | 14%       | 19%        | 40%      |
   | Positional answers with at least one point (of 31) | 5       | 8       | 15     | 11        | 13         | 23       |
   | Answers with a false board claim (of 75)           | 6       | 2       | 3      | 5         | 10         | 5        |
   | Seconds per answer                                 | 12      | 11      | 18     | 17        | 11         | 20       |
   | Cost per answer (list price for Claude)            | $0.0008 | $0.0063 | $0.016 | $0.0018   | $0.023     | $0.057   |

   Tactics are close to solved for Terra, Sol, Sonnet and Opus. Positional ideas are not: Opus is
   clearly the best and still conveys well under half of the annotators' reasoning, and facts
   about attacks pull the answers further towards attacks. Still open:
   - Give the companion positional facts and vocabulary: pawn structure, open and half-open files,
     outposts, good and bad bishops, weak squares, space, which pieces have no moves.
   - Let answers about ideas be longer and structured as plan, reason and what the alternative
     gives up; the prompt asks for short answers, and the reference reasoning has three or four
     points.
   - Luna got worse at tactics with facts (it found the first move in 15 of 20, down from 20);
     find out why before considering it as the default.
   - Repeat the eval with more than one run per model; the numbers are small.
   - The eval now defaults to Sonnet for answers and grading, with a `--quick` sample of 24
     questions, so a change can be tried for about 66 requests. Scores from it are not comparable
     with the tables above: the judge differs (Sonnet, not Opus) and the wording of the idea
     questions changed ("A strong player chose X" instead of "White played X here", which had
     confused Haiku).

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
