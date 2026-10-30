- Austin cameras show their hardware maker. Austin's catalog names each camera's
  maker or product line (Wisenet, Advidia, Sarix, Spectra Enhanced, Axis), which
  the pack now serves as `manufacturer` on `/api/cctv/sources`. The HUD shows
  `HW <MAKER>` and the camera panel adds the label. Pelco Spectra is a PTZ-only
  line, so those cameras are labelled `(PTZ)`: their listed facing is at best a
  home position. The maker never changes the pose or FOV estimate (bassem
  chagra, @ch-bas, #884).
