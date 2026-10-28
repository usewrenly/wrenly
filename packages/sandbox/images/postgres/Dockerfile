# Repository-owned PostgreSQL toolchain. Resolve the built image ID per resource;
# never pull a replacement automatically when reopening an existing database.
FROM postgres:17-alpine
RUN test "$PG_MAJOR" = 17 && test "$(id -u postgres)" = 70
USER 70:70
ENTRYPOINT ["postgres"]
CMD ["-D", "/var/lib/postgresql/data", "-c", "unix_socket_directories=/tmp"]
