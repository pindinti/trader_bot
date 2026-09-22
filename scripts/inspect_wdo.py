
from pathlib import Path
from collections import Counter
import csv

DATA_DIR = Path("data/wdo")

for path in sorted(DATA_DIR.glob("*_WDO.csv")):
    contracts = Counter()
    updates = Counter()
    sessions = Counter()
    total = 0

    with path.open(
        "r",
        encoding="utf-8-sig",
        newline=""
    ) as file:

        reader = csv.DictReader(file, delimiter=";")

        for row in reader:
            total += 1

            contracts[row["CodigoInstrumento"]] += 1
            updates[row["AcaoAtualizacao"]] += 1
            sessions[row["TipoSessaoPregao"]] += 1

    print(f"\nArquivo: {path.name}")
    print(f"Total de registros: {total:,}")

    print("\nContratos:")
    for key, value in contracts.items():
        print(f"  {key}: {value:,}")

    print("\nAções de atualização:")
    for key, value in updates.items():
        print(f"  {key}: {value:,}")

    print("\nTipos de sessão:")
    for key, value in sessions.items():
        print(f"  {key}: {value:,}")