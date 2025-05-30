const path = require('path');
const fs = require('fs');
const { db } = require('../config/db');
const { sendShareNotification } = require('../services/emailService');

exports.getDashboard = async (req, res) => {
  try {
    const userDocs = await db.query(
      `SELECT id, title, description, file_path, document_type, created_at
       FROM documents WHERE user_id = $1`,
      [req.user.id]
    );

    res.render('documents/dashboard', {
      documents: userDocs.rows.map(d => ({ 
        ...d, 
        owner_name: 'You' 
      })),
      user: req.user,
      error: null
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.redirect('/');
  }
};

exports.uploadDocument = async (req, res) => {
  try {
    if (!req.file) throw new Error('No file uploaded');
    const { title, description, document_type } = req.body;
    const filePath = `/uploads/${req.file.filename}`;
    
    await db.query(
      `INSERT INTO documents (user_id, title, description, file_path, document_type)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.user.id, title, description, filePath, document_type]
    );
    
    res.redirect('/documents');
  } catch (err) {
    console.error('Upload error:', err);
    try {
      const docsRes = await db.query(
        `SELECT id, title, description, file_path, document_type, created_at
         FROM documents WHERE user_id = $1`,
        [req.user.id]
      );
      res.status(400).render('documents/dashboard', {
        documents: docsRes.rows.map(d => ({ ...d, owner_name: 'You' })),
        error: err.message
      });
    } catch (inner) {
      console.error('Upload recovery error:', inner);
      res.redirect('/documents');
    }
  }
};

exports.showSharePage = async (req, res) => {
  const docId = req.params.id;
  try {
    const docRes = await db.query(
      `SELECT id, title, description, file_path, document_type, created_at
       FROM documents WHERE id=$1 AND user_id=$2`,
      [docId, req.user.id]
    );
    
    if (!docRes.rows.length) return res.redirect('/documents');
    const document = docRes.rows[0];
    
    const sharesRes = await db.query(
      `SELECT s.id, s.permissions, s.expiry_date, u.email AS shared_with_email
       FROM document_shares s
       JOIN users u ON u.id = s.shared_with
       WHERE s.document_id = $1`,
      [docId]
    );
    
    res.render('documents/share', {
      document,
      shares: sharesRes.rows,
      error: null,
      prevInput: {}
    });
  } catch (err) {
    console.error('Share page error:', err);
    res.redirect('/documents');
  }
};

exports.handleShare = async (req, res) => {
  const { document_id, shared_with, permissions, expiry_date } = req.body;
  try {
    const userRes = await db.query('SELECT id FROM users WHERE email=$1', [shared_with]);
    if (!userRes.rows.length) throw new Error('User not found');
    
    const sharedWithId = userRes.rows[0].id;
    await db.query(
      `INSERT INTO document_shares (document_id, shared_by, shared_with, permissions, expiry_date)
       VALUES ($1,$2,$3,$4::TEXT[],$5)`,
      [document_id, req.user.id, sharedWithId,
       Array.isArray(permissions) ? permissions : [permissions],
       expiry_date || null]
    );
    
    const docMeta = await db.query('SELECT title, file_path FROM documents WHERE id=$1', [document_id]);
    const absPath = path.join(__dirname, '../public', docMeta.rows[0].file_path);
    
    await sendShareNotification(req.user.name, shared_with, docMeta.rows[0].title, permissions, absPath);
    res.redirect(`/documents/share/${document_id}`);
  } catch (err) {
    console.error('Share error:', err);
    try {
      const docRes2 = await db.query(
        'SELECT id, title, description, file_path, document_type, created_at FROM documents WHERE id=$1 AND user_id=$2',
        [document_id, req.user.id]
      );
      
      const shares2 = await db.query(
        `SELECT s.id, s.permissions, s.expiry_date, u.email AS shared_with_email
         FROM document_shares s JOIN users u ON u.id=s.shared_with WHERE s.document_id=$1`,
        [document_id]
      );
      
      res.status(400).render('documents/share', {
        document: docRes2.rows[0] || { id: document_id },
        shares: shares2.rows,
        error: err.message,
        prevInput: { shared_with, permissions, expiry_date }
      });
    } catch(inner) {
      console.error('Share recovery error:', inner);
      res.redirect('/documents');
    }
  }
}; 

exports.deleteDocument = async (req, res) => {
  const docId = req.params.id;
  try {
    const docRes = await db.query('SELECT file_path FROM documents WHERE id=$1 AND user_id=$2', [docId, req.user.id]);
    if (!docRes.rows.length) return res.redirect('/documents');
    
    const fsPath = path.join(__dirname, '../public', docRes.rows[0].file_path);
    fs.unlink(fsPath, err => err && console.error('unlink error:', err));
    
    await db.query('DELETE FROM document_shares WHERE document_id=$1', [docId]);
    await db.query('DELETE FROM documents WHERE id=$1', [docId]);
    
    res.redirect('/documents');
  } catch(err) {
    console.error('Delete error:', err);
    res.redirect('/documents');
  }
}; 