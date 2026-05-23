# Hawaii Election Dashboard

Live: https://elections.ainavotes.com

Interactive precinct-level dashboard covering Hawaii's 2022 and 2024 general and primary elections, with turnout statistics and demographic context.

## What's here

- `index.html` + `dashboard.js` — the single-page dashboard (Plotly.js + Alpine.js, no backend)
- `data.js` — index-encoded bundle: ~100K election rows, 967 turnout rows, 247 precincts with census demographics
- `preprocess.py` — regenerates `data.js` from the three source Excel workbooks
- `Hawaii_Elections_Combined_l (1).xlsx` — election results + turnout statistics by precinct
- `Precint_Mapping.xlsx` — precinct → House / Senate / US House / County Council mapping
- `cleaned_precincts.xlsx` — Census demographic data per precinct

## Updating the data

```bash
python preprocess.py
```

Reads the three Excels, writes `data.js`. Commit and push to update the live site.

## Filters

- **Year:** 2022 / 2024
- **Election Type:** Primary / General
- **District:** select any combination of HD / SD / Congressional / County Council districts
- **Race:** select one or more races for side-by-side comparison
- **Vote Type:** combine Mail + In-Person, or split them

## Built for ʻĀina Votes.
