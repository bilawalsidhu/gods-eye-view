- Fire-perimeter queries handle outlines and holes crossing the antimeridian:
  areas enclosed near ±180° are included, areas at the opposite meridian are
  excluded, and returned perimeter coordinates stay near the dateline. Incident
  cards use the same circular longitude mean and compare multipart outline
  areas along short longitude edges, keeping the card on the largest polygon
  (Arianna Method, @ariannamethod, #1142).
