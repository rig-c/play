# @rig-c/play stability inventory

## Turn dials

| Root export | Stable contract |
| --- | --- |
| `discoverTurnDials(model, durations?)` | Reads compiled model JSON and returns at most one dial per axis in yaw, pitch, body order. A supplied duration list takes precedence over the serialized durations. The model's bindings and slider mapping determine the exact bone, channel and range. Ambiguous or unusable bindings are skipped. |
| `TurnAxis` | The literals `'yaw'`, `'pitch'` and `'body'`. |
| `TurnDial` | The fields `axis`, `bone`, `slider`, `channel`, `min`, `max` and `provenance`. Bone and slider names retain their namespaces. Provenance is human-readable and its wording may evolve. |
| `normalizedDial(value, range)` | Maps normalized input to a range around zero (or the nearest endpoint if zero is outside the range). Inputs outside `[-1, 1]` clamp to the corresponding endpoint. |

See the [turn dial reference](REFERENCE.md#discovering-turn-dials) for matching,
range calculation and use with `BoneAdjust`.
