- The place suggester asks Photon for candidates while a place is typed: at
  most one request every 500 ms per tab, none for a minute after a refusal
  or a failed request, and never text that may be private (an email address,
  long numbers, an IBAN shape, a password, PIN, token or key). An empty
  `PHOTON_URL` turns it off along with the place search. The search box that
  uses it follows (manjunath22466, samehkhamis, #1814).
