- Voice viewport escalation now emits compact reason-code diagnostics without
  recording tool payloads. The policy still prefers structured entity identity,
  preserves the live point-and-ask crop added in #837, and does not add image
  requests, change image retention or automatically widen visual scope.
  This follows asturksever's #835 review; credit the #837 pointer-crop authors.
