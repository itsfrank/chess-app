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
   - `npm run lab` is the inner loop for this work: frozen engine context per question, one
     model request per answer, free metrics and a batched head-to-head judge. First result, on
     Haiku over 12 questions: rewriting the prompt around plans (`ideas` against `current`) took
     engine scores quoted per answer from 3.3 to 0 but conveyed no more of the reasoning (10 → 9
     of 36 points). The prompt alone is not the lever; the missing piece is information.
   - Lab results, 19 November 2026 (Haiku answers, Sonnet judge; "of 36" is the 12-question
     sample, "of 86" all 31 questions). The judge's point count for the same answers moved between
     7 and 12 of 36 across runs, so read the win/loss split first and treat 2–3 points as noise.

     | Strategy (`evals/strategies.ts`)                                              | Against        | Points conveyed | Better / worse / tie | p    | Scores quoted per answer | Words     |
     | ----------------------------------------------------------------------------- | -------------- | --------------- | -------------------- | ---- | ------------------------ | --------- |
     | `ideas`: prompt rewritten around plans                                        | `current`      | 10 → 9 of 36    | 2 / 3 / 7            | 1.0  | 3.3 → 0                  |           |
     | `positional`: + positional facts, and their change right after the move       | `current`      | 12 → 14 of 36   | 2 / 1 / 9            | 1.0  | 3.3 → 4.3                | 171 → 214 |
     | `consequences`: + their change by the end of the engine's line after the move | `current`      | 7 → 16 of 36    | **8 / 0 / 4**        | 0.01 | 3.3 → 2.8                | 171 → 220 |
     | `consequences`, all 31 questions                                              | `current`      | 22 → 35 of 86   | **13 / 4 / 14**      | 0.05 | 3.1 → 3.5                | 172 → 222 |
     | `consequences`, answered by Sonnet                                            | `current`      | 15 → 20 of 36   | 5 / 2 / 5            | 0.45 | 6.1 → 4.3                | 248 → 296 |
     | `coach`: + two-part answer (what changes, the idea) and a theme checklist     | `consequences` | 14 → 12 of 36   | 2 / 3 / 7            | 1.0  | 2.8 → 0.1                | 220 → 259 |
     | `threat`: + what the opponent would play if the mover passed                  | `consequences` | 15 → 10 of 36   | 0 / 7 / 5            | 0.02 | 3.3 → 2.2                | 213 → 228 |

     What this says: information beats instructions, but only information about where the move
     leads. Positional facts of the position alone were cited as a checklist ("the rook sits on an
     outpost") without changing the explanation; the same facts at the end of the engine's line let
     Haiku say what the move is for, and on this sample Haiku with them (15–16 of 36) roughly
     matches Sonnet without them (15). Prompt changes move style (scores quoted fall to almost
     nothing under `ideas` and `coach`) but not substance. The null-move line hurt: in quiet
     positions the engine's "pass" move is a regrouping rather than the plan annotators describe,
     and Haiku took it as proof that a prophylactic move was not prophylactic. Questions of the form
     "why is X not best" barely moved under any strategy (Tsvetkov–Smyslov's queen trade stays at 0
     even with the facts showing the bad bishop and that neither king can advance: the answers still
     call the moves equal on the engine's score); Fischer–Petrosian went from 0 to 1 of 2 with
     `consequences` and 2 of 2 with `coach`.

     A second round changed the loop first: `npm run lab -- score` judges each answer once, point
     by point, and stores it, so a baseline is never judged again; `--samples N` asks each question
     N times; `--holdout` is the 19 questions outside the dozen. Calibration on the dozen: two
     samples of one strategy differ by 1–2 points of 36, so read differences of 3 or more; per-answer
     scores are much stricter than the pairwise counts (`current` 2.5, `consequences` 9 of 36 by
     Sonnet); Haiku as judge agrees with Sonnet on 126 of 144 points, is more lenient, reached the same
     verdict (6 better, 0 worse) and costs about a fifteenth as much, so it screens and Sonnet confirms.
     At list price a Haiku answer is $0.001–0.002, Sonnet judging $0.004 per answer, Haiku judging
     $0.0003. Screened with two samples and the Haiku judge against `consequences` (12.5 of 36):

     | Strategy   | Points of 36 | Better / worse | What it tried                                                                          |
     | ---------- | ------------ | -------------- | -------------------------------------------------------------------------------------- |
     | `compact`  | 9.0          | 1 / 6          | the same information as text instead of JSON (about 7% cheaper)                        |
     | `paired`   | about 11     | 3 / 4          | changes as feature: before → after; for "why not X" both moves' line ends side by side |
     | `lineonly` | 10.0         | 1 / 6          | only the line-end change, without the position's own facts                             |
     | `farther`  | 9.0          | 1 / 6          | also the change after the line is continued to about 18 half-moves                     |

     None beat `consequences`; with `threat` and `coach` the pattern is that more on top of it does
     not help Haiku and may dilute it, and the format does not matter. On the 19 held-out questions,
     scored per answer by Sonnet, `consequences` led `current` 16 to 12 of 50 but split 3 better, 3
     worse, 13 level: three large wins (Karpov–Unzicker 0 → 3, Lasker–Capablanca 1 → 3,
     Spassky–Fischer 0 → 2) where the line shows the transformation, and small losses. So the facts
     help a lot on some questions and not on most. Next: ship the positional facts and the line-end
     change (as fields of `analyze_position`'s result) behind a setting and confirm with
     `npm run eval -- --quick --suites ideas`; grow `evals/ideas.json`, especially "why not X"
     questions, which no strategy has moved; tag reference points by theme to see which kinds of
     idea the facts reach.

     The same ten strategies with Sonnet answering (one sample, Sonnet judge, the dozen). Haiku's
     answers under the same judge scored 2.5 (`current`) and 9 (`consequences`) of 36:

     | Strategy       | Points of 36 | Better / worse vs `current` | $ per answer |
     | -------------- | ------------ | --------------------------- | ------------ |
     | `current`      | 12           |                             | 0.024        |
     | `ideas`        | 11           | 1 / 2                       | 0.028        |
     | `positional`   | 11           | 2 / 3                       | 0.028        |
     | `consequences` | 13           | 2 / 1                       | 0.031        |
     | `coach`        | 18           | 5 / 0 (p = 0.06)            | 0.031        |
     | `threat`       | 13           | 3 / 2                       | 0.030        |
     | `compact`      | 12           | 1 / 1                       | 0.026        |
     | `paired`       | 13           | 4 / 2                       | 0.026        |
     | `lineonly`     | 15           | 4 / 2                       | 0.023        |
     | `farther`      | 15           | 4 / 1                       | 0.034        |

     The pattern reverses from Haiku's. Sonnet with the shipped prompt already does better than
     Haiku with any strategy, and the facts alone add little to it (`consequences` 13); what helps
     Sonnet is the instructions, `coach` (the facts and line-end change plus the two-part
     "what changes / the idea" guide and the list of themes), the only strategy with no question
     worse. Fischer–Petrosian goes to 2 of 2 under `coach`, as with Haiku; Tsvetkov–Smyslov,
     Johner–Nimzowitsch and Carlsen–Aronian stay at 0 under every strategy. One sample: differences
     under about 3 points are noise, so `coach` needs a second sample (with `current`, `lineonly`
     and `farther`, about $1.60 at list price) before it is shipped. A Sonnet answer costs 12–15
     times a Haiku one.

     Opus answering (`--model opus`, same judge, five strategies) did no better: `current` 12,
     `coach` 16 (4 better, 1 worse), `farther` 15, `consequences` 13, `lineonly` 12, at
     $0.042–0.064 per answer, about twice Sonnet. `coach` leads again, so the guide with the facts
     is the consistent winner for the larger models. The same three questions stay at 0 under every
     model and strategy, which points at their reference points or the judge rather than the
     model; read those answers before adding strategies.

     Coaching on club players' games is now measured with two suites (`--suites tutor,coach`):
     `tutor`, 37 questions on Lichess rapid games between 1300–1800 players with reference points
     worked out by the engine (what the move allowed or missed, a better move, a habit; for quiet
     positions a plan), and `coach`, 59 questions on readers' games annotated by IM Silman with his
     points as the reference (built locally from copyrighted articles, never committed). The first
     run with Sonnet found that a third of the answers were only captions for the arrows: the model
     explained in its reasoning, drew arrows, and wrote "I've drawn the arrows…", so the user never
     saw the explanation. Fixed, in order, through the full eval (one sample of 96 answers each):

     | Change                                                                     | Caption only | `tutor` | `coach` | False claims | $ per answer |
     | -------------------------------------------------------------------------- | ------------ | ------- | ------- | ------------ | ------------ |
     | shipped                                                                    | 33           | 63%     | 28%     | 11           | 0.021        |
     | prompt: the user sees only the reply                                       | 28           | 64%     | 33%     | 32           | 0.025        |
     | `set_arrows` result says to write the full answer now                      | 14           | 70%     | 43%     | 16           | 0.016        |
     | reasoning effort low instead of medium (not kept)                          | 14           | 66%     | 38%     | 23           | 0.020        |
     | a reply under 50 words after arrows gets one hidden "answer in full?" turn | 1            | 85%     | 44%     | 19           | 0.018        |

     The rest of the gap on `coach` is substance: on Silman's games the companion defers to the
     engine where he judges positionally (it called 15…Nd5 "a fine move, not a mistake; the engine
     review doesn't flag it" where he calls it a soft move and wants 15…a5!), and on plans it rarely
     ties the plan to the position's features. Many false claims are loose coaching language read
     literally ("eyes the knight", "pins down"), some are real.

     Further changes, each measured on all 96 questions. Two samples of the same setup agreed on
     241 of 276 points and differed by 0 points on `tutor`, 3 on `coach` and 3 false claims, so
     read 5 or more on `coach` as real. False claims are recounted with the current checker, which
     now accepts relative pins ("Bg4 pins the knight to the queen"), so they differ slightly from
     the table above.

     | Change                                                                                          | `tutor` | `coach` | False claims | $ per answer | Seconds |
     | ----------------------------------------------------------------------------------------------- | ------- | ------- | ------------ | ------------ | ------- |
     | coaching section in the prompt (purpose of a move, thinking errors, imbalances; not kept)       | 79%     | 48%     | 28           | 0.027        | 13      |
     | `diagnose_move`: what a move allowed, a threat already there, a win not taken (two samples)     | 82%     | 47–50%  | 20–22        | 0.015–0.020  | 12      |
     | positional facts and their change by each line's end in `analyze_position`, plans in the prompt | 87%     | 52%     | 26           | 0.031        | 12      |
     | reply's board claims checked by the rules, false ones sent back to be rewritten (Haiku)         | 88%     | 52%     | 8            | 0.025¹       | 37      |
     | the same with Sonnet, a compact one-line format and paragraphs checked in parallel              | 87%     | 49%     | 4            | 0.057        | 23      |
     | reply in three parts (what happened, why it matters, the lesson)                                | 91%     | 54%     | 4            | 0.068        | 25      |
     | claims checked while the reply arrives; plan questions name the move played                     | 86%     | 54%     | 6            | 0.059        | 24      |
     | longer engine search, 3 s (not kept)                                                            | 88%     | 48%     | 8            | 0.054        | 25      |
     | a hidden "reread it as a master coach" turn after the check (not kept)                          | 90%     | 44%     | 11           | 0.062        | 33      |

     ¹ Without the check's own cost, which the later rows include. Haiku was the slow one: about
     3,300 hidden reasoning tokens and 16 seconds for a paragraph that Sonnet did in 8.

     How far to trust these rows: one `coach` question's score moves by about ±30 points between
     two runs of the same setup, because whether an answer happens to make Silman's particular
     point varies from sample to sample (the judge, regrading the same answers, agrees with itself
     on 95% of points). The whole suite is therefore uncertain by about ±5 points, so most of the
     3–6 point steps above are within noise; only the caption fixes and the claim check are
     clearly real.

- Ideas are now screened before a full run by replaying only the final writing step: the
  recorded question and tool results of 40 answers (30 `coach`, 10 `tutor` plan questions),
  with the idea's prompt or extra information, against two control replays. With the tool
  results fixed, a replay costs about $0.024 including grading and the 40 run in two to three
  minutes, about a tenth of a full run, and `tutor` noise halves (`coach` noise does not,
  being in the writing). The scripts are local (`.data/lab/`), since they read the `coach`
  answers. Ten ideas screened so far, all against the shipped setup:

  | Idea                                                                 | `coach`   | `tutor` plans | False claims¹ |
  | -------------------------------------------------------------------- | --------- | ------------- | ------------- |
  | no "keep explanations short" (28% more words)                        | +7.1 ±3.7 | +10 ±4.9      | 10            |
  | what the opponent would play if the player passed, with its line     | −3.7 ±4.9 | +15 ±4.9      | 9             |
  | the top three moves and the move played, with what each line changes | −3.5 ±4.0 | +7.5 ±4.6     | 9             |
  | a list of positional principles and club players' thinking errors    | +3.2 ±4.9 | +2.5 ±3.6     | 9             |
  | a first call lists a master's points, a second writes from them      | +4.9 ±5.0 | −7.5 ±6.0     | 20            |
  | Opus writes the answer                                               | +2.4 ±5.1 | −5.0 ±3.3     | 5             |
  | best of two answers, picked by a judge without the reference points  | −2.6 ±2.4 | +2.5 ±2.5     | 9             |
  | name the deciding imbalances first                                   | −2.9 ±6.4 | +5.0 ±5.0     | 14            |
  | start from what the student was probably thinking                    | −2.1 ±4.9 | +2.5 ±6.4     | 15            |
  | `diagnose_move` on the move played when the model did not call it    | −3.7 ±4.0 | +2.5 ±3.6     | 7             |

  ¹ In the 40 replayed answers, unchecked; the controls had 7 and 9. Telling the model how to
  think added false claims without adding coverage; new, checked engine information helped
  where it was what was missing (the opponent's free move on plan questions, though the `tutor`
  plan points were themselves built from it); letting the answer run longer was the only change
  that moved `coach`. Next: a full run of the first two together.

- Bridged calls now ask Claude Code for the five-minute prompt cache instead of the hour-long
  one it uses on a subscription (twice the input price, and never read again by one-off
  grading calls), and estimates price cache writes accordingly. With claim checks left out of
  screens unless asked for, a screened answer went from about $0.085 to $0.024.

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
