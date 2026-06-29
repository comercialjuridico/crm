# WhatsApp CRM — Uso Interno

CRM simples para gerenciar conversas e grupos do WhatsApp com etiquetas e controle de pendências.

## Requisitos

- Node.js 18+
- Google Chrome instalado (usado pelo whatsapp-web.js)

## Instalação

```bash
cd "CRM COMERCIAL JURIDICO"
npm install
```

## Rodando

```bash
npm start
```

Acesse: **http://localhost:3000**

## Primeiro uso

1. Abra http://localhost:3000
2. Um QR Code aparecerá na tela
3. No celular: WhatsApp → Dispositivos vinculados → Vincular dispositivo → Escaneie o QR
4. Aguarde a sincronização das conversas

## Funcionalidades

- **Lista de conversas e grupos** com busca e filtros
- **Etiquetas personalizadas** com cores (Urgente, Aguardando, Em andamento, Concluído + crie as suas)
- **Marcar como "Não tratado"** — destaca conversas que precisam de atenção
- **Histórico de mensagens** dentro do CRM
- **Tempo real** — novas mensagens aparecem automaticamente

## Filtros disponíveis

- Todos / Grupos / Conversas diretas / Não tratados
- Filtro por etiqueta (clique na etiqueta na barra de filtros)

## Observações

- A sessão fica salva — não precisa escanear o QR toda vez
- O banco de dados (`crm.db`) fica na pasta do projeto
- Para uso em rede interna, altere `PORT=3000` no início do server.js
