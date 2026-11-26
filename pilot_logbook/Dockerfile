ARG BUILD_FROM
FROM $BUILD_FROM

COPY integration /integration/pilot_logbook
COPY run.sh /
# Strip Windows line endings (an upload from a PC can add them) so the script always starts on Linux
RUN tr -d '\r' < /run.sh > /run.tmp && mv /run.tmp /run.sh && chmod a+x /run.sh

CMD [ "/run.sh" ]
