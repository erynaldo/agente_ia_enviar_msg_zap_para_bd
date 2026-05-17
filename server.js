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

// 4. O Coração do Sistema: Monitorando as Mensagens Recebidas
client.on('message', async (msg) => {
  // Opcional: Filtre para responder apenas às suas mensagens (evita salvar grupos ou chats de terceiros)
  // Substitua pelo seu número ou comente a linha abaixo para aceitar de qualquer um
  // if (msg.from !== '55XXXXXXXXXXX@c.us') return;

  console.log(`Mensagem recebida de ${msg.from}: ${msg.body}`);

  try {
    // Chamando a IA para estruturar o texto
    const prompt = `
      Você é o NeoDB. Analise a seguinte mensagem enviada pelo usuário e extraia:
      1. Categoria (ex: Tarefa, Ideia, Financeiro, Lembrete, Nota)
      2. Conteúdo extraído (resumo limpo e direto)
      3. Tags relevantes (máximo 3, em formato de lista separada por vírgula)

      Mensagem: "${msg.body}"

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
    });

    // Tratando a resposta da IA
    const jsonDados = JSON.parse(aiResponse.text.trim());

    // 5. Salvando no PostgreSQL (Neon.tech)
    const queryText = `
      INSERT INTO registros_whatsapp (numero_usuario, mensagem_original, categoria, conteudo_extraido, tags)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id;
    `;
    
    const values = [
      msg.from, 
      msg.body, 
      jsonDados.categoria, 
      jsonDados.conteudo_extraido, 
      jsonDados.tags
    ];

    const resBanco = await pool.query(queryText, values);
    const idSalvo = resBanco.rows[0].id;

    // 6. Respondendo de volta no WhatsApp do usuário
    msg.reply(`✅ *Salvo com sucesso no Neon.tech!*
• *Categoria:* ${jsonDados.categoria}
• *Tags:* [${jsonDados.tags.join(', ')}]
• *ID:* ${idSalvo}`);

  } catch (error) {
    console.error('Erro ao processar/salvar mensagem:', error);
    msg.reply('❌ Erro interno ao tentar processar e salvar sua mensagem.');
  }
});

client.initialize();

// Porta padrão para o Render não dar timeout
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor HTTP ativo na porta ${PORT}`));