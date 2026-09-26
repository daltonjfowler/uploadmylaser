# Golden files

`.rd` files saved from LightBurn (**File → Save RD file**) on the RDC6445S. The encoder is checked
against these, and `web/serial-test.html` replays them over USB.

Name each file for what it does, and note its LightBurn settings here:

| File | What | Speed | Max / Min power | Notes |
|---|---|---|---|---|
| square-cut.rd | 20 mm square, cut | | | |
| line-score.rd | 30 mm line, score | | | |
| square-fill.rd | 20 mm filled square, fill engrave | | | |
| text.rd | "Hi", fill engrave | | | |

Decode one with: `cd container && python -m app.ruida.decoder ../test/golden/square-cut.rd`
