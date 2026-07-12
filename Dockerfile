# Self-contained image: Kanboard with the Kanteen plugin baked in.
# Build once, then `docker run` anywhere — no repo, no bind mounts, no cert prep.
#
#   docker build -t kanboard-offline .
#   docker run -d --name kanboard -p 443:443 \
#     -v kanboard_data:/var/www/app/data --restart unless-stopped kanboard-offline
#
# The base image self-signs a TLS cert on first boot, so 443 works immediately and
# the plugin loads with zero config. For OFFLINE to work on other devices you still
# need a cert they trust — mount one at runtime (see the two extra -v lines in
# INSTALL.md) and install the CA on each device. That step is a browser rule, not ours.
# Pinned for reproducible builds — bump this tag deliberately, not implicitly.
FROM kanboard/kanboard:v1.2.46
COPY Kanteen /var/www/app/plugins/Kanteen
