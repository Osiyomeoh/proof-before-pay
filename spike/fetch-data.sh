#!/bin/sh
# Downloads the public NREL data used by the physics spike into spike/data (not committed). Run from spike/.
set -e
mkdir -p data
B=https://oedi-data-lake.s3.amazonaws.com/pvdaq/2023-solar-data-prize/2105_OEDI
curl -sS -m 180 -o data/irr.csv "$B/data/2105_irradiance_data.csv"
curl -sS -m 60 -o data/meta.json "$B/metadata/2105_system_metadata.json"
for i in 01 02 03 07; do curl -sS -m 180 -o "data/2105_inv${i}_data.csv" "$B/data/2105_inv${i}_data.csv"; done
curl -sS -m 60 -o data/pvw.json "https://developer.nlr.gov/api/pvwatts/v8.json?api_key=${NREL_API_KEY:-DEMO_KEY}&system_capacity=10&module_type=0&losses=14&array_type=1&tilt=10&azimuth=180&lat=20.884134&lon=-156.340543&timeframe=hourly"
