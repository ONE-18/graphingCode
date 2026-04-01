FROM nginx:alpine

# Copia el reporte como index para que esté disponible en /
COPY static_analysis.html /usr/share/nginx/html/index.html
COPY static_analysis.css /usr/share/nginx/html/
COPY static_analysis.js /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
