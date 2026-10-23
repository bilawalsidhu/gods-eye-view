- Export the KartaView and Panoramax Street Level providers, so a host composing
  its own provider list can offer the keyless providers without Mapillary
  (samehkhamis, #1324).
- A Mapillary source can take a `graphEndpoint`, a Graph API base that adds the
  token itself (such as a same-origin proxy). Its sequence lookups go there
  through the source's transport, and the photo viewer uses MapillaryJS's
  Graph provider at that endpoint, so no client token is needed in the page
  (samehkhamis, #1324).
