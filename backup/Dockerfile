FROM postgres:18.6-alpine3.23

RUN apk add --no-cache age aws-cli bash coreutils

COPY recipient.pub /etc/repo-ing-backup-recipient.pub
COPY backup.sh /usr/local/bin/repo-ing-backup
RUN chmod 0444 /etc/repo-ing-backup-recipient.pub \
    && chmod 0555 /usr/local/bin/repo-ing-backup

USER postgres
ENTRYPOINT ["/usr/local/bin/repo-ing-backup"]
