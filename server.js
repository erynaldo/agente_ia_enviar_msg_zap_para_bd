require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Pool } = require('pg');
const { GoogleGenAI } = require('@google/genai');
const qrImage = require('qr-image');

const app = express();
app.use(express.json());

// 1. Configuração do Banco Neon.tech
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Obrigatório para o Neon
});

// 2. Configuração da IA (Gemini)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 3. Inicialização do WhatsApp Bot
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'], // Obrigatório para rodar no Render
  }
});


let ultimoQR = null;

client.on('qr', (qr) => {
  console.log('Novo QR Code gerado! Acesse a URL do seu app /qrcode para escanear.');
  ultimoQR = qr; // Salva o texto do QR Code na memória
});

// Rota para acessar pelo navegador e escanear com o celular
app.get('/qrcode', (req, res) => {
  if (!ultimoQR) {
    return res.send('O WhatsApp já está conectado ou o QR Code ainda não foi gerado.');
  }

  // Transforma o texto do QR Code em uma imagem PNG real
  const code = qrImage.image(ultimoQR, { type: 'png' });
  res.type('png');
  code.pipe(res);
});


// Mostra o QR Code no terminal do Render para você logar o WhatsApp
// client.on('qr', (qr) => {
//   console.log('ESCANEIE O QR CODE ABAIXO NO SEU WHATSAPP:');
//   qrcode.generate(qr, { small: true });
// });

client.on('ready', () => {
  console.log('NeoDB está online e conectado ao WhatsApp!');
});

// 4. O Coração do Sistema: Monitorando as Mensagens
client.on('message_create', async (msg) => {
  
  // FILTRO 1: Ignorar atualizações de Status/Stories
  if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') {
    return;
  }

  // FILTRO 2: Garantir que a mensagem é de VOCÊ para VOCÊ MESMO (Chat "Você")
  // No WhatsApp Web, quando você envia mensagem para si mesmo, msg.from e msg.to são iguais
  const ehConversaComigoMesmo = msg.from === msg.to;

  if (!ehConversaComigoMesmo) {
    return; // Se for conversa com outras pessoas ou grupos, ignora
  }

  // Limpa espaços em branco extras nas pontas do texto
  const textoOriginal = msg.body.trim();

  // FILTRO 3: Verificar se o texto começa com a palavra-chave "agendar"
  // O uso do regex /^agendar/i aceita "agendar", "Agendar", "AGENDAR:" etc.
  if (!/^agendar/i.test(textoOriginal)) {
    return; // Se não começar com "agendar", ignora silenciosamente
  }

  console.log(`Palavra-chave detectada! Processando agendamento: ${textoOriginal}`);

  try {
    // Limpeza: Remove a palavra "agendar" e possíveis dois pontos (:) ou espaços do início do texto
    // Exemplo: "agendar: reunião na sexta" vira apenas "reunião na sexta"
    const textoLimpo = textoOriginal.replace(/^agendar\s*:?\s*/i, '');

    // Chamando a IA para estruturar o texto já limpo
    const prompt = `
      Você é o NeoDB. Analise a seguinte anotação enviada pelo usuário e extraia:
      1. Categoria (ex: Tarefa, Ideia, Financeiro, Lembrete, Nota)
      2. Conteúdo extraído (resumo limpo e direto)
      3. Tags relevantes (máximo 3, em formato de lista separada por vírgula)

      Mensagem: "${textoLimpo}"

      Responda ESTRITAMENTE no formato JSON abaixo, sem blocos de código markdown ou texto adicional:
      {
        "categoria": "...",
        "conteudo_extraido": "...",
        "tags": ["tag1", "tag2"]
      }
    `;

    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const jsonDados = JSON.parse(aiResponse.text.trim());

    // Salvando no PostgreSQL (Neon.tech)
    const queryText = `
      INSERT INTO registros_whatsapp (numero_usuario, mensagem_original, categoria, conteudo_extraido, tags)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id;
    `;
    
    const values = [
      msg.from, // O seu próprio número de WhatsApp
      textoOriginal, // Salva a mensagem completa com o "agendar" para histórico
      jsonDados.categoria, 
      jsonDados.conteudo_extraido, 
      jsonDados.tags
    ];

    const resBanco = await pool.query(queryText, values);
    const idSalvo = resBanco.rows[0].id;

    // Responde no seu próprio chat confirmando o salvamento
    await client.sendMessage(msg.to, `✅ *Salvo com sucesso no Neon.tech!*
• *Categoria:* ${jsonDados.categoria}
• *Tags:* [${jsonDados.tags.join(', ')}]
• *ID:* ${idSalvo}`);

  } catch (error) {
    console.error('Erro ao processar/salvar mensagem:', error);
  }
});

client.initialize();

// Porta padrão para o Render não dar timeout
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor HTTP ativo na porta ${PORT}`));