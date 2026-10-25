const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = 3000;
// Product image upload settings
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, "public/uploads/");
    },

    filename: function (req, file, cb) {
        const uniqueName =
            Date.now() + "-" + Math.round(Math.random() * 1E9);

        cb(
            null,
            uniqueName + path.extname(file.originalname)
        );
    }
});

const upload = multer({
    storage: storage,
    fileFilter: function (req, file, cb) {
        const allowedTypes = [
            "image/jpeg",
            "image/png",
            "image/webp"
        ];

        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only JPG, PNG, and WEBP images are allowed."));
        }
    },
    limits: {
        fileSize: 5 * 1024 * 1024
    }
});

// Allows the server to receive data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: "negrosia-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60
    }
}));

// Allows Express to use files inside the public folder
app.use(express.static("public"));

// PostgreSQL database connection
const pool = new Pool(
    process.env.DATABASE_URL
        ? {
            connectionString: process.env.DATABASE_URL,
            ssl: {
                rejectUnauthorized: false
            }
        }
        : {
            user: process.env.DB_USER,
            host: process.env.DB_HOST,
            database: process.env.DB_NAME,
            password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT
        }
);

// Test the database connection
pool.query("SELECT NOW()")
    .then(() => {
        console.log("Connected to Negrosia database!");
    })
    .catch((error) => {
        console.error("Database connection error:", error.message);
    });
// Register a new user
app.post("/register", async (req, res) => {
    try { 
        console.log("Registration request received:", req.body);
        const { fullName, email, accountType, password, confirmPassword } = req.body;

        // Check if all fields are filled in
        if (!fullName || !email || !accountType || !password || !confirmPassword) {
            return res.status(400).send("Please fill in all fields.");
        }

        // Check if passwords match
        if (password !== confirmPassword) {
            return res.status(400).send("Passwords do not match.");
        }

        // Only allow customer or seller accounts
        if (accountType !== "customer" && accountType !== "seller") {
            return res.status(400).send("Invalid account type.");
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Save the user to PostgreSQL
        await pool.query(
            `INSERT INTO users (full_name, email, password, account_type)
             VALUES ($1, $2, $3, $4)`,
            [fullName, email, hashedPassword, accountType]
        );

        res.send("Account created successfully!");

    } catch (error) {

        // PostgreSQL error for duplicate email
        if (error.code === "23505") {
            return res.status(400).send("This email is already registered.");
        }

        console.error(error);
        res.status(500).send("Something went wrong.");
    }
});
// Login user
app.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        // Check if email and password are filled in
        if (!email || !password) {
            return res.status(400).send("Please enter your email and password.");
        }

        // Find the user using their email
        const result = await pool.query(
            "SELECT * FROM users WHERE email = $1",
            [email]
        );

        // Check if the account exists
        if (result.rows.length === 0) {
            return res.status(400).send("Invalid email or password.");
        }

        const user = result.rows[0];

        // Compare the entered password with the hashed password
        const passwordMatch = await bcrypt.compare(
            password,
            user.password
        );

        if (!passwordMatch) {
            return res.status(400).send("Invalid email or password.");
        }

       // Save user information in the session
req.session.user = {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    accountType: user.account_type
};

// Send user to the correct page
if (user.account_type === "seller") {
    res.redirect("/seller.html");
} else {
    res.redirect("/index.html");
}

    } catch (error) {
        console.error(error);
        res.status(500).send("Something went wrong.");
    }
});
// Add a new product
app.post("/add-product", upload.single("productImage"), async (req, res) => {
    try {
        // Make sure the user is logged in
        if (!req.session.user) {
            return res.status(401).send("Please login first.");
        }

        // Only sellers can add products
        if (req.session.user.accountType !== "seller") {
            return res.status(403).send("Only sellers can add products.");
        }

        const { productName, category, description, price } = req.body;
        const imageUrl = req.file
    ? "/uploads/" + req.file.filename
    : null;

        // Check required fields
        if (!productName || !category || !price) {
            return res.status(400).send("Please fill in all required fields.");
        }

        // Save product to PostgreSQL
      await pool.query(
    `INSERT INTO products
    (seller_id, product_name, category, description, price, image_url)
    VALUES ($1, $2, $3, $4, $5, $6)`,
    [
        req.session.user.id,
        productName,
        category,
        description,
        price,
        imageUrl
    ]
);
      

        res.redirect("/shop.html");

    } catch (error) {
        console.error(error);
        res.status(500).send("Something went wrong.");
    }
});
// Get all active products for the Shop page
app.get("/api/products", async (req, res) => {

    try {

        const result = await pool.query(`
            SELECT
                products.id,
                products.product_name,
                products.category,
                products.description,
                products.price,
                products.image_url,
                users.full_name AS seller_name
            FROM products
            JOIN users
            ON products.seller_id = users.id
            WHERE products.is_active = TRUE
            ORDER BY products.created_at DESC
        `);

        res.json(result.rows);

    } catch (error) {

        console.error(
            "Products error:",
            error
        );

        res.status(500).json({
            message: "Unable to load products."
        });

    }

});
// Place a new order
app.post("/api/orders", async (req, res) => {

    const client = await pool.connect();

    try {

        // Customer must be logged in
        if (!req.session.user) {
            return res.status(401).json({
                message: "Please login first."
            });
        }

        const {
            fullName,
            phone,
            address,
            paymentMethod,
            cart
        } = req.body;


        // Check required information
        if (
            !fullName ||
            !phone ||
            !address ||
            !paymentMethod ||
            !cart ||
            cart.length === 0
        ) {
            return res.status(400).json({
                message: "Please complete your order information."
            });
        }


        // Calculate total
        let totalAmount = 0;

        cart.forEach(product => {

            totalAmount +=
                Number(product.price) *
                product.quantity;

        });


        // Start database transaction
        await client.query("BEGIN");


        // Save main order
        const orderResult = await client.query(
            `INSERT INTO orders
            (
                customer_id,
                full_name,
                phone,
                delivery_address,
                payment_method,
                total_amount,
                status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id`,
            [
                req.session.user.id,
                fullName,
                phone,
                address,
                paymentMethod,
                totalAmount,
                "Pending"
            ]
        );


        const orderId =
            orderResult.rows[0].id;


        // Save each product in the order
        for (const product of cart) {

            await client.query(
                `INSERT INTO order_items
                (
                    order_id,
                    product_id,
                    quantity,
                    price
                )
                VALUES ($1, $2, $3, $4)`,
                [
                    orderId,
                    product.id,
                    product.quantity,
                    product.price
                ]
            );

        }


        // Save everything
        await client.query("COMMIT");


        res.json({
            message: "Order placed successfully!",
            orderId: orderId
        });


    } catch (error) {

        await client.query("ROLLBACK");

        console.error(
            "Order error:",
            error
        );

        res.status(500).json({
            message: "Unable to place order."
        });

    } finally {

        client.release();

    }

});

// Get orders and products of the logged-in customer
app.get("/api/my-orders", async (req, res) => {

    try {

        // Check if user is logged in
        if (!req.session.user) {
            return res.status(401).json({
                message: "Please login first."
            });
        }

        // Get customer's orders
        const ordersResult = await pool.query(
            `SELECT
                id,
                full_name,
                phone,
                delivery_address,
                payment_method,
                total_amount,
                status,
                created_at
             FROM orders
             WHERE customer_id = $1
             ORDER BY created_at DESC`,
            [req.session.user.id]
        );

        const orders = ordersResult.rows;


        // Get products for each order
        for (const order of orders) {

            const itemsResult = await pool.query(
                `SELECT
                    order_items.product_id,
                    order_items.quantity,
                    order_items.price,
                    products.product_name,
                    products.image_url
                 FROM order_items
                 JOIN products
                 ON order_items.product_id = products.id
                 WHERE order_items.order_id = $1`,
                [order.id]
            );

            order.items = itemsResult.rows;
        }


        res.json(orders);

    } catch (error) {

        console.error(
            "My orders error:",
            error
        );

        res.status(500).json({
            message: "Unable to load your orders."
        });

    }

});
// Get orders for the logged-in seller
app.get("/api/seller-orders", async (req, res) => {

    try {

        // Check if user is logged in
        if (!req.session.user) {
            return res.status(401).json({
                message: "Please login first."
            });
        }

        // Only sellers can view seller orders
        if (req.session.user.accountType !== "seller") {
            return res.status(403).json({
                message: "Seller access only."
            });
        }

        const result = await pool.query(
            `SELECT
                orders.id AS order_id,
                orders.full_name AS customer_name,
                orders.phone,
                orders.delivery_address,
                orders.payment_method,
                orders.status,
                orders.created_at,

                order_items.quantity,
                order_items.price,

                products.product_name,
                products.image_url

             FROM order_items

             JOIN orders
             ON order_items.order_id = orders.id

             JOIN products
             ON order_items.product_id = products.id

             WHERE products.seller_id = $1

             ORDER BY orders.created_at DESC`,
            [req.session.user.id]
        );

        res.json(result.rows);

    } catch (error) {

        console.error(
            "Seller orders error:",
            error
        );

        res.status(500).json({
            message: "Unable to load seller orders."
        });

    }

});
// Update order status
app.put("/api/orders/:id/status", async (req, res) => {

    try {

        // Check login
        if (!req.session.user) {
            return res.status(401).json({
                message: "Please login first."
            });
        }

        // Only sellers
        if (req.session.user.accountType !== "seller") {
            return res.status(403).json({
                message: "Seller access only."
            });
        }

        const orderId = req.params.id;
        const { status } = req.body;

        const allowedStatuses = [
            "Pending",
            "Processing",
            "Shipped",
            "Completed"
        ];

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({
                message: "Invalid order status."
            });
        }

        // Make sure this seller has a product in this order
        const checkResult = await pool.query(
            `SELECT 1
             FROM order_items
             JOIN products
             ON order_items.product_id = products.id
             WHERE order_items.order_id = $1
             AND products.seller_id = $2
             LIMIT 1`,
            [
                orderId,
                req.session.user.id
            ]
        );

        if (checkResult.rows.length === 0) {
            return res.status(403).json({
                message: "You cannot update this order."
            });
        }

        // Update status
        await pool.query(
            `UPDATE orders
             SET status = $1
             WHERE id = $2`,
            [status, orderId]
        );

        res.json({
            message: "Order status updated successfully!"
        });

    } catch (error) {

        console.error(
            "Update order status error:",
            error
        );

        res.status(500).json({
            message: "Unable to update order status."
        });

    }

});
// Logout
app.get("/logout", (req, res) => {

    req.session.destroy((error) => {

        if (error) {
            console.error(
                "Logout error:",
                error
            );

            return res.status(500).send(
                "Unable to logout."
            );
        }

        res.redirect("/login.html");

    });

});
// Get active products of the logged-in seller
app.get("/api/seller-products", async (req, res) => {

    try {

        // Check if user is logged in
        if (!req.session.user) {

            return res.status(401).json({
                message: "Please login first."
            });

        }

        // Only sellers can access this
        if (req.session.user.accountType !== "seller") {

            return res.status(403).json({
                message: "Seller access only."
            });

        }

        // Get only active products belonging to this seller
        const result = await pool.query(
            `SELECT
                id,
                product_name,
                category,
                description,
                price,
                image_url,
                created_at
             FROM products
             WHERE seller_id = $1
             AND is_active = TRUE
             ORDER BY created_at DESC`,
            [req.session.user.id]
        );

        res.json(result.rows);

    } catch (error) {

        console.error(
            "Seller products error:",
            error
        );

        res.status(500).json({
            message: "Unable to load your products."
        });

    }

});
// Get one product for editing
app.get("/api/seller-products/:id", async (req, res) => {

    try {

        if (!req.session.user) {
            return res.status(401).json({
                message: "Please login first."
            });
        }

        if (req.session.user.accountType !== "seller") {
            return res.status(403).json({
                message: "Seller access only."
            });
        }

        const productId = req.params.id;

        const result = await pool.query(
            `SELECT
                id,
                product_name,
                category,
                description,
                price,
                image_url
             FROM products
             WHERE id = $1
             AND seller_id = $2`,
            [
                productId,
                req.session.user.id
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Product not found."
            });
        }

        res.json(result.rows[0]);

    } catch (error) {

        console.error(
            "Get product error:",
            error
        );

        res.status(500).json({
            message: "Unable to load product."
        });

    }

});
// Update seller product
app.put("/api/seller-products/:id", async (req, res) => {

    try {

        // Check if user is logged in
        if (!req.session.user) {
            return res.status(401).json({
                message: "Please login first."
            });
        }

        // Only sellers can update products
        if (req.session.user.accountType !== "seller") {
            return res.status(403).json({
                message: "Seller access only."
            });
        }

        const productId = req.params.id;

        const {
            productName,
            category,
            description,
            price
        } = req.body;


        // Check required fields
        if (!productName || !category || !price) {
            return res.status(400).json({
                message: "Please fill in all required fields."
            });
        }


        // Update the product
        const result = await pool.query(
            `UPDATE products
             SET
                product_name = $1,
                category = $2,
                description = $3,
                price = $4
             WHERE id = $5
             AND seller_id = $6
             RETURNING id`,
            [
                productName,
                category,
                description,
                price,
                productId,
                req.session.user.id
            ]
        );


        // Product does not exist or does not belong to seller
        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Product not found."
            });
        }


        res.json({
            message: "Product updated successfully!"
        });


    } catch (error) {

        console.error(
            "Update product error:",
            error
        );

        res.status(500).json({
            message: "Unable to update product."
        });

    }

});
// Delete seller product
// Remove seller product
app.delete("/api/seller-products/:id", async (req, res) => {

    try {

        // Check if user is logged in
        if (!req.session.user) {
            return res.status(401).json({
                message: "Please login first."
            });
        }

        // Only sellers can remove products
        if (req.session.user.accountType !== "seller") {
            return res.status(403).json({
                message: "Seller access only."
            });
        }

        // Get the product ID from the URL
        const productId = req.params.id;

        // Deactivate the product instead of permanently deleting it
        const result = await pool.query(
            `UPDATE products
             SET is_active = FALSE
             WHERE id = $1
             AND seller_id = $2
             RETURNING id`,
            [
                productId,
                req.session.user.id
            ]
        );

        // Product not found or doesn't belong to this seller
        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Product not found."
            });
        }

        res.json({
            message: "Product removed successfully!"
        });

    } catch (error) {

        console.error(
            "Remove product error:",
            error
        );

        res.status(500).json({
            message: "Unable to remove product."
        });

    }

});
// Seller dashboard statistics
app.get("/api/seller-dashboard", async (req, res) => {

    try {

        // Check if logged in
        if (!req.session.user) {
            return res.status(401).json({
                message: "Please login first."
            });
        }

        // Only sellers
        if (req.session.user.accountType !== "seller") {
            return res.status(403).json({
                message: "Seller access only."
            });
        }

        const sellerId = req.session.user.id;

        // Count active products
        const productsResult = await pool.query(
            `SELECT COUNT(*) AS total
             FROM products
             WHERE seller_id = $1
             AND is_active = TRUE`,
            [sellerId]
        );

        // Count orders containing this seller's products
        const ordersResult = await pool.query(
            `SELECT COUNT(DISTINCT orders.id) AS total
             FROM orders
             JOIN order_items
             ON orders.id = order_items.order_id
             JOIN products
             ON order_items.product_id = products.id
             WHERE products.seller_id = $1`,
            [sellerId]
        );

        // Count pending orders
        const pendingResult = await pool.query(
            `SELECT COUNT(DISTINCT orders.id) AS total
             FROM orders
             JOIN order_items
             ON orders.id = order_items.order_id
             JOIN products
             ON order_items.product_id = products.id
             WHERE products.seller_id = $1
             AND orders.status = 'Pending'`,
            [sellerId]
        );

        res.json({
            activeProducts:
                Number(productsResult.rows[0].total),

            totalOrders:
                Number(ordersResult.rows[0].total),

            pendingOrders:
                Number(pendingResult.rows[0].total)
        });

    } catch (error) {

        console.error(
            "Seller dashboard error:",
            error
        );

        res.status(500).json({
            message: "Unable to load dashboard."
        });

    }

});
// Start the server
app.listen(PORT, () => {
    console.log(`Negrosia is running at http://localhost:${PORT}`);
});