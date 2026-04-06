FROM nginx:alpine

# Copia los assets web y archivos de ejemplo para que el fetch funcione.
COPY static_analysis.html /usr/share/nginx/html/index.html
COPY static_analysis.css /usr/share/nginx/html/
COPY src /usr/share/nginx/html/src
COPY examples /usr/share/nginx/html/examples

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
