## Correction v2 of the published A-D results (D1 bound field, D2 disposition; not a new test)

| Source | Row | Trades | R/trade (unchanged) | optimistic bound published (v1) | optimistic bound correction v2 | trades whose bound changed | = audit admissible bound |
|---|---|---|---|---|---|---|---|
| test.json | A | 7441 | -0.286 | -0.281 | -0.285 | 25 | yes |
| test.json | B | 1726 | -0.244 | -0.234 | -0.242 | 7 | yes |
| test.json | C | 2168 | -0.093 | -0.092 | -0.093 | 4 | yes |
| de_test_WTICO_USD.json WTICO/USD | A: every flip, immediate (frozen baseline) | 7441 | -0.286 | -0.281 | -0.285 | 25 | - |
| de_test_WTICO_USD.json WTICO/USD | D-nogate: same follower, always on | 1803 | -0.103 | -0.099 | -0.102 | 4 | yes |
| de_test_WTICO_USD.json WTICO/USD | D-imm: same gate, enter at discovery | 768 | -0.158 | -0.158 | -0.158 | 0 | - |
| de_test_WTICO_USD.json WTICO/USD | D: frozen | 241 | -0.108 | -0.107 | -0.108 | 1 | yes |
| de_test_XAU_USD.json XAU/USD | A: every flip, immediate (frozen baseline) | 7027 | -0.161 | -0.154 | -0.155 | 20 | - |
| de_test_XAU_USD.json XAU/USD | D-nogate: same follower, always on | 2994 | -0.105 | -0.100 | -0.099 | 7 | - |
| de_test_XAU_USD.json XAU/USD | D-imm: same gate, enter at discovery | 6193 | -0.114 | -0.109 | -0.109 | 12 | - |
| de_test_XAU_USD.json XAU/USD | D: frozen | 2994 | -0.105 | -0.100 | -0.099 | 7 | - |

Dispositions:

- WTICO/USD E: published "insufficient support: fit rows 1175, cal rows 15 (0 trades):..." -> correction v2: undefined: E unavailable (insufficient support: fit rows 1175, cal rows 15); E was never fitted, no test of E, no verdict
- WTICO/USD E_novol: published "insufficient support: fit rows 1175, cal rows 15 (0 trades):..." -> correction v2: undefined: E unavailable (insufficient support: fit rows 1175, cal rows 15); E was never fitted, no test of E, no verdict
- XAU/USD E: published "no entries (0 trades): rejected. The frozen D+E is the no-tr..." -> correction v2: unchanged (E was fitted; the no-trade policy was scored)
- XAU/USD E_novol: published "no entries (0 trades): rejected. The frozen D+E is the no-tr..." -> correction v2: unchanged (E was fitted; the no-trade policy was scored)
