import express from 'express';
import dotenv from 'dotenv';
import path from "node:path";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use("/public", express.static(path.join(process.cwd(), "public")));

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.listen(PORT, () => {
  console.log(`S.O.S. chatbot running on :${PORT}`);
});