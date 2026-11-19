ARG BUILD_FROM
FROM $BUILD_FROM

COPY integration /integration/pilot_logbook
COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
