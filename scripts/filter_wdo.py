
from pathlib import Path
import csv
import re

# --------------------------------------------------
# CONFIGURAÇÃO
# --------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent.parent

INPUT_DIR = BASE_DIR / "data" / "raw"
OUTPUT_DIR = BASE_DIR / "data" / "wdo"

CHUNK_SIZE = 100_000

# WDO + letra de vencimento + dois dígitos do ano
WDO_PATTERN = re.compile(r"^WDO[FGHJKMNQUVXZ]\d{2}$")

# --------------------------------------------------
# PROCESSAMENTO
# --------------------------------------------------

def filter_file(input_path: Path):
    output_path = OUTPUT_DIR / f"{input_path.stem}_WDO.csv"

    total_rows = 0
    wdo_rows = 0
    contracts = {}

    print(f"\nProcessando: {input_path.name}")

    # Arquivo temporário evita deixar saída incompleta
    # com nome definitivo caso o processo falhe.
    temp_path = output_path.with_suffix(".tmp")

    try:
        with input_path.open(
            "r",
            encoding="utf-8-sig",
            newline=""
        ) as source, temp_path.open(
            "w",
            encoding="utf-8",
            newline=""
        ) as target:

            reader = csv.DictReader(source, delimiter=";")

            if not reader.fieldnames:
                raise ValueError("Arquivo sem cabeçalho.")

            if "CodigoInstrumento" not in reader.fieldnames:
                raise ValueError(
                    "Coluna CodigoInstrumento não encontrada."
                )

            writer = csv.DictWriter(
                target,
                fieldnames=reader.fieldnames,
                delimiter=";",
                extrasaction="raise"
            )

            writer.writeheader()

            for row in reader:
                total_rows += 1

                instrument = (
                    row["CodigoInstrumento"] or ""
                ).strip().upper()

                if WDO_PATTERN.fullmatch(instrument):
                    writer.writerow(row)

                    wdo_rows += 1

                    contracts[instrument] = (
                        contracts.get(instrument, 0) + 1
                    )

                if total_rows % CHUNK_SIZE == 0:
                    print(
                        f"  {total_rows:,} linhas lidas | "
                        f"{wdo_rows:,} WDO"
                    )

        # Publicar a saída somente após concluir a leitura.
        temp_path.replace(output_path)

    except Exception:
        temp_path.unlink(missing_ok=True)
        raise

    print("\nResultado:")
    print(f"  Linhas lidas: {total_rows:,}")
    print(f"  Negócios WDO: {wdo_rows:,}")

    print("\nContratos encontrados:")

    for contract, count in sorted(contracts.items()):
        print(f"  {contract}: {count:,}")

    print(f"\nArquivo gerado: {output_path.name}")

    return total_rows, wdo_rows


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    files = sorted(INPUT_DIR.glob("*.txt"))

    if not files:
        print("Nenhum arquivo TXT encontrado em data/raw/")
        return

    grand_total = 0
    grand_wdo = 0

    for file in files:
        total, wdo = filter_file(file)

        grand_total += total
        grand_wdo += wdo

    print("\n" + "=" * 50)
    print("PROCESSAMENTO CONCLUÍDO")
    print(f"Total de linhas: {grand_total:,}")
    print(f"Total WDO: {grand_wdo:,}")
    print("=" * 50)


if __name__ == "__main__":
    main()