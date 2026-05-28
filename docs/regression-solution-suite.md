# Regression solution replay suite

Read when changing validation feedback, regression rechecks, or dashboard replay behavior.

The dashboard keeps these validation-review layers together inside the Validation Review Workbench:

- Validation anomalies: latest dataset review findings.
- Regression cases: durable records of reviewed error scenarios with source evidence.
- General solution replay suite: grouped error classes that can be replayed repeatedly.

## Solution classes

Recorded regression cases are grouped into reusable solution classes:

- `potential-minus-sign-discipline`: preserve faint minus signs and treat Table 3/Table 6 source-positive values as polarity anomalies, not silent forced negatives.
- `table4-current-decimal-scale`: inspect Table 4 current decimal points and mA/mV units before accepting large integer-like values.
- `table3-five-reading-completeness`: keep Table 3 directional rows at five readings unless source evidence proves a missing value.
- `station-pairing-coverage`: group Table 5/Table 6 values by station/anode labels plus image proximity.
- `general-anomaly-review`: fallback until a repeated pattern is clear enough to promote.

## Replay loop

Each solution card shows:

- The general problem.
- The reusable fix.
- The detection rule.
- The agent graph from validation review through focused OpenAI recheck.
- Counts for solved, open, needs-review, and not-run cases.
- Concrete before-to-after evidence readings from latest replay.

`Replay this solution` starts `regression_recheck.py --solution-id <id>`, so only matching recorded cases are re-run through the focused OpenAI vision leaf.

The purpose is not to show only the latest validation decision. The purpose is to prove that an identified class of mistakes can be reproduced and then repeatedly corrected across its recorded examples.
