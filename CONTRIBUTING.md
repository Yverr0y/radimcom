# Contributing to RADIMCOM

Bug reports, ideas and pull requests are welcome. By taking part you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

- **Bugs and feature requests:** open an [issue](https://github.com/om2amr/RADIMCOM/issues/new/choose).
- **Questions and help with setup:** use [Discussions](https://github.com/om2amr/RADIMCOM/discussions).
- **Security problems:** do not open an issue, see [SECURITY.md](SECURITY.md).

For a larger change, please open an issue first so we can agree on the approach before you spend time on it.

## Running from source

RADIMCOM runs on Windows with Python 3.9 or newer.

```bash
python -m venv .venv
.venv\Scripts\pip install -r installer\requirements.txt
.venv\Scripts\pip install --no-deps PyFT8
```

`PyFT8` is needed only for the FT8 decoder.

The third-party binaries in `lib\` and `drivers\` are not in git. Take them from the
[install zip](https://github.com/om2amr/RADIMCOM/releases/latest), or see
[Requirements](docs/installation.md#requirements) in docs/installation.md for their sources. Then use `setup.bat` for the first setup and
`start.bat` to run the receiver.

## Pull requests

- Keep each pull request to one topic.
- Write code, comments and documentation in English.
- Update `README.md` when behaviour changes, and `API/API.md` when the HTTP API changes.
- Update `CHANGELOG.md` and `installer/INSTALL.txt` for changes users will notice.
- Do not change the version number or build release packages. The maintainer does that.
- Do not commit `data\`, `dist\`, `lib\`, `drivers\`, recordings, logs, dongle serial numbers or anything else from
  your own station.

## Testing

There is no automated test suite, so please test by hand and say in the pull request what you tested and on which
hardware. Where it helps, include a recording or a sample message for a decoder change.

## Transmitting

Anything that touches transmit code or the TX band limits needs extra care. The limits and the TX disclaimer must stay
in place, and transmit tests should use a dummy load. Please describe these changes in an issue first. See
[NOTICE.md](NOTICE.md).

## Licence

Contributions are accepted under the [MIT License](LICENSE). A new third-party component has to be added to
[NOTICE.md](NOTICE.md) with its licence, and to `installer/make_sources.py` if it is GPL or LGPL and goes into the
release package.
