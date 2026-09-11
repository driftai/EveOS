"""Shared EveOS server-module bootstrap."""

from .eveos_ports import bootstrap_environment


# Importing any EveOS server module now receives one canonical port map first.
# Explicit environment overrides still win because bootstrap_environment uses setdefault().
bootstrap_environment()
