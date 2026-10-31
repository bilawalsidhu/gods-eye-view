- Cut the Google requests the HUD's AI summary makes on its own. It no longer
  looks up place names when no OpenAI key is configured, reverse-geocodes at
  most two points instead of up to four, and looks up again only once the view
  shows a different area, not after every small pan, so a small pan no longer
  asks OpenAI for a new summary either (samehkhamis, #0000).
