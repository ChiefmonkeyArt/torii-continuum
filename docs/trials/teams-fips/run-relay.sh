#!/bin/bash
# As fipstrial on the VPS. In-memory relay on the mesh address only.
. /opt/fips-trial/env   # VPS_FD=fd..., VPS_NPUB=npub1...
exec /opt/fips-trial/bin/nak serve --hostname "$VPS_FD" --port 10547
