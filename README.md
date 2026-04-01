# Análisis estático — Informe

Descripción
-----------

Este directorio contiene el informe de análisis estático del proyecto en formato HTML.

Contenido
--------

- `static_analysis.html` — Reporte completo de análisis estático (HTML).

Cómo ver el informe
-------------------

1. Abrir `static_analysis.html` directamente en un navegador.
2. Desde la terminal (Linux):

```bash
xdg-open static_analysis.html
```

Alternativa (servidor local):

```bash
python3 -m http.server 8000
# y abrir http://localhost:8000/static_analysis.html
```

Notas
-----

- El informe es un artefacto estático y no requiere servidor.
- Fecha de actualización: 2026-04-01.
- Si quieres que extraiga secciones del HTML a Markdown o que añada capturas, dímelo y lo preparo.

**Docker**

- **Build:** `docker build -t graphingcode .`
- **Run (Docker):** `docker run --rm -p 8080:80 graphingcode`
- **Run (docker-compose):** `docker-compose up --build -d`
- Abrir `http://localhost:8080/` (o `http://localhost:8080/static_analysis.html`).

Estos pasos arrancan un contenedor Nginx que sirve el informe estático en el puerto `8080`.
